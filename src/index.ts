/**
 * Cloudflare Worker: Paddle webhook → download email (Resend) + purchase record (Supabase).
 *
 * Routes:
 *   POST /api/webhook/paddle  — Paddle transaction.completed webhook
 *   GET  /download?token=...  — Serve file from R2 using unique token
 *
 * Hosted checkout handles the redirect. This Worker only processes the
 * webhook (email + DB) and serves secure download links from emails.
 */

import { verifyPaddleSignature } from "./paddle";
import type { PaddleWebhookPayload, KVTransactionRecord, KVTokenRecord } from "./types";
import { getCustomerEmail } from "./types";

export interface Env {
  DOWNLOADS_KV: KVNamespace;
  PRODUCTS_R2: R2Bucket;
  PADDLE_WEBHOOK_SECRET: string;
  RESEND_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

const DOWNLOAD_EXPIRY_DAYS = 30;

/** Redact for logs: show last 4 chars only. */
function tail4(s: string): string {
  if (!s || s.length <= 4) return "****";
  return "****" + s.slice(-4);
}

/**
 * Normalize a download path/slug into a full R2 object key.
 * - If it contains a slash, treat it as a full path (e.g. "New Opening Products/file.zip").
 * - Otherwise treat it as a slug and expand to "products/{slug}.zip".
 */
function normalizeR2Key(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.includes("/")) return trimmed;
  return `products/${trimmed}.zip`;
}

/**
 * Extract download_path from the webhook payload. Checks three locations:
 * 1. Product-level custom_data  (set once in Paddle dashboard)
 * 2. Price-level custom_data    (alternative location)
 * 3. Transaction-level custom_data (backward compat with Paddle.js customData)
 */
function extractDownloadPath(data: PaddleWebhookPayload["data"]): string {
  const firstItem = data.items?.[0];

  const fromProduct = firstItem?.product?.custom_data?.download_path;
  if (fromProduct) return fromProduct;

  const fromPrice = firstItem?.price?.custom_data?.download_path;
  if (fromPrice) return fromPrice;

  const fromTransaction = data.custom_data?.download_path;
  if (fromTransaction) return fromTransaction;

  return "";
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ── POST /api/webhook/paddle ────────────────────────────────────
    if (path === "/api/webhook/paddle" && method === "POST") {
      console.log("[webhook] Request received");
      const rawBody = await request.text();
      const signature = request.headers.get("Paddle-Signature");
      const valid = await verifyPaddleSignature(rawBody, signature, env.PADDLE_WEBHOOK_SECRET);
      if (!valid) {
        console.error("[webhook] Invalid signature");
        return jsonResponse({ error: "Invalid signature" }, 401);
      }
      console.log("[webhook] Signature valid");

      let payload: PaddleWebhookPayload;
      try {
        payload = JSON.parse(rawBody) as PaddleWebhookPayload;
      } catch {
        console.error("[webhook] Invalid JSON");
        return jsonResponse({ error: "Invalid JSON" }, 400);
      }

      console.log("[webhook] Event type:", payload.event_type);
      if (payload.event_type !== "transaction.completed") {
        console.log("[webhook] Ignoring", payload.event_type);
        return new Response("OK", { status: 200 });
      }

      const transactionId = payload.data?.id;
      if (!transactionId) {
        console.error("[webhook] Missing data.id");
        return jsonResponse({ error: "Missing transaction id" }, 400);
      }
      console.log("[webhook] transaction.completed, txn:", transactionId);

      ctx.waitUntil(processWebhook(request.url, payload, env));
      return jsonResponse({ received: true }, 200);
    }

    // ── GET /download?token=... ─────────────────────────────────────
    if (method === "GET" && path === "/download") {
      const token = url.searchParams.get("token");
      const debug = url.searchParams.get("debug") === "1";
      console.log("[download] GET", { token: token ? tail4(token) : null, debug });

      if (!token) {
        console.warn("[download] Missing token");
        return debug
          ? jsonResponse({ error: "Missing token" }, 400)
          : htmlResponse("Missing token", 400);
      }

      const record = await env.DOWNLOADS_KV.get(`token_${token}`);
      if (!record) {
        console.warn("[download] Token not found in KV");
        return debug
          ? jsonResponse({ error: "Link not found or expired" }, 404)
          : htmlResponse("Link not found or expired.", 404);
      }

      const data = JSON.parse(record) as KVTokenRecord;
      if (new Date(data.expiresAt) < new Date()) {
        console.warn("[download] Link expired:", data.expiresAt);
        return debug
          ? jsonResponse({ error: "Link expired", expiresAt: data.expiresAt }, 410)
          : htmlResponse("This download link has expired. Contact support for a new link.", 410);
      }

      console.log("[download] Token valid, r2Key:", data.r2Key);
      const object = await env.PRODUCTS_R2.get(data.r2Key);
      if (!object) {
        console.error("[download] R2 object not found:", data.r2Key);
        return debug
          ? jsonResponse({ error: "File not found", r2Key: data.r2Key }, 404)
          : htmlResponse("File not found.", 404);
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      const filename = data.r2Key.split("/").pop() || "download";
      headers.set("Content-Disposition", `attachment; filename="${filename}"`);
      headers.set("Cache-Control", "no-store");
      if (!headers.get("Content-Type") || headers.get("Content-Type")?.startsWith("text/")) {
        headers.set("Content-Type", "application/octet-stream");
      }
      console.log("[download] Serving file:", filename);
      return new Response(object.body, { status: 200, headers });
    }

    console.log("[worker] No route matched:", method, path);
    return new Response("Not found", { status: 404 });
  },
};

// ── Background webhook processing ─────────────────────────────────

async function processWebhook(
  requestUrl: string,
  payload: PaddleWebhookPayload,
  env: Env
): Promise<void> {
  const data = payload.data;
  const transactionId = data.id;
  const baseUrl = new URL(requestUrl).origin;
  console.log("[processWebhook] Start, txn:", transactionId);

  // Idempotency check
  const existing = await env.DOWNLOADS_KV.get(`txn_${transactionId}`);
  if (existing) {
    console.log("[processWebhook] Already processed, skipping");
    return;
  }

  // Extract product info
  const firstItem = data.items?.[0];
  const priceId = firstItem?.price?.id ?? "";
  const productName =
    firstItem?.product?.name ||
    data.details?.line_items?.[0]?.product?.name ||
    "Digital product";
  const amountTotal = data.details?.totals?.grand_total ?? data.details?.totals?.total ?? "";
  const currency = data.currency_code ?? "";
  const customerEmail = getCustomerEmail(data);

  // Extract download_path from product > price > transaction custom_data
  const rawPath = extractDownloadPath(data);
  const r2Key = normalizeR2Key(rawPath);
  console.log("[processWebhook] product:", productName, "price:", priceId, "download_path:", rawPath || "(none)", "r2Key:", r2Key || "(none)");

  if (!r2Key) {
    console.error("[processWebhook] No download_path found. Set custom_data.download_path on the product in Paddle.");
  }

  // Generate download token (even if no r2Key, so we record the purchase)
  const downloadToken = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + DOWNLOAD_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const txnRecord: KVTransactionRecord = { downloadToken, createdAt };
  const tokenRecord: KVTokenRecord = { r2Key, expiresAt };

  await env.DOWNLOADS_KV.put(`txn_${transactionId}`, JSON.stringify(txnRecord));
  if (r2Key) {
    await env.DOWNLOADS_KV.put(`token_${downloadToken}`, JSON.stringify(tokenRecord));
  }
  console.log("[processWebhook] KV written");

  // ── Supabase: insert purchase record ──
  try {
    console.log("[processWebhook] Supabase insert...");
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/purchases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        transaction_id: transactionId,
        customer_email: customerEmail || "unknown",
        product_name: productName,
        price_id: priceId,
        amount_total: amountTotal,
        currency,
        download_path: rawPath || null,
        items: data.items ?? [],
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error("[processWebhook] Supabase insert failed:", res.status, t);
    } else {
      console.log("[processWebhook] Supabase insert OK");
    }
  } catch (e) {
    console.error("[processWebhook] Supabase error:", e);
  }

  // ── Resend: download email ──
  const downloadUrl = r2Key ? `${baseUrl}/download?token=${downloadToken}` : "";
  if (customerEmail) {
    try {
      console.log("[processWebhook] Sending download email...");
      const emailHtml = r2Key
        ? `<h2>Thanks for your purchase!</h2>
           <p>Product: <strong>${productName}</strong></p>
           <p>Download your file here:</p>
           <p><a href="${downloadUrl}" style="display:inline-block;padding:12px 24px;background:#000;color:#fff;text-decoration:none;border-radius:4px;">Download</a></p>
           <p style="color:#666;font-size:0.9em;">This link expires in ${DOWNLOAD_EXPIRY_DAYS} days.</p>`
        : `<h2>Thanks for your purchase!</h2>
           <p>Product: <strong>${productName}</strong></p>
           <p>Your order has been confirmed. Transaction: ${transactionId}</p>`;

      const resendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: "New Opening Supply <onboarding@resend.dev>",
          to: [customerEmail],
          subject: r2Key ? "Your download is ready" : "Order confirmation",
          html: emailHtml,
        }),
      });
      if (!resendRes.ok) {
        const t = await resendRes.text();
        console.error("[processWebhook] Resend failed:", resendRes.status, t);
      } else {
        console.log("[processWebhook] Resend email sent OK");
      }
    } catch (e) {
      console.error("[processWebhook] Resend error:", e);
    }
  } else {
    console.warn("[processWebhook] No customer email — skipping email");
  }

  console.log("[processWebhook] Done, txn:", transactionId);
}

// ── Helpers ─────────────────────────────────────────────────────────

function htmlResponse(html: string, status: number): Response {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>New Opening Supply</title></head><body>${html}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

function jsonResponse(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
