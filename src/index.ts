/**
 * Cloudflare Worker: Paddle checkout → unique download link, Supabase, Resend.
 * Routes: POST /api/webhook/paddle, GET /thankyou, GET /download, GET /api/thankyou/status
 */

import { verifyPaddleSignature } from "./paddle";
import type { PaddleWebhookPayload, KVTransactionRecord, KVTokenRecord } from "./types";
import { PRICE_TO_R2_KEY, getCustomerEmail } from "./types";

export interface Env {
  DOWNLOADS_KV: KVNamespace;
  PRODUCTS_R2: R2Bucket;
  PADDLE_WEBHOOK_SECRET: fuck you;
  RESEND_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

const DOWNLOAD_EXPIRY_DAYS = 30;

/** Redact for logs: show last 4 chars of token/id. */
function tail4(s: string): string {
  if (!s || s.length <= 4) return "****";
  return "****" + s.slice(-4);
}

/** CORS headers for cross-origin requests (e.g. Webflow success page polling the Worker). */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function corsJsonResponse(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight for /api/thankyou/status and /download (needed by Webflow success page)
    if (method === "OPTIONS" && (path === "/api/thankyou/status" || path === "/download")) {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // GET /api/webhook/paddle — if someone uses this as success URL by mistake, show help (Paddle may redirect here via GET or POST)
    if (path === "/api/webhook/paddle") {
      const baseUrl = new URL(request.url).origin;
      const thankyouUrl = `${baseUrl}/thankyou`;
      if (method === "GET") {
        console.warn("[webhook] GET request to webhook URL — success URL is likely misconfigured");
        return htmlResponse(
          `<h1>Wrong URL for checkout success</h1><p>This is the <strong>webhook</strong> endpoint (for Paddle server-to-server calls). Do not use it as your checkout success or redirect URL.</p><p>Use this instead: <strong><a href="${thankyouUrl}">${thankyouUrl}</a></strong></p><p>In Webflow, set your Buy button’s success URL to the Worker thank-you page with your success page as <code>redirect</code>, e.g.<br><code>${thankyouUrl}?redirect=https://yoursite.com/thank-you</code></p><p>See the project README for the correct script (successUrl must point to /thankyou?redirect=...).</p>`,
          200
        );
      }

      // POST /api/webhook/paddle — Paddle webhook
      console.log("[webhook] Request received");
      const rawBody = await request.text();
      const signature = request.headers.get("Paddle-Signature");
      const valid = await verifyPaddleSignature(rawBody, signature, env.PADDLE_WEBHOOK_SECRET);
      if (!valid) {
        console.error("[webhook] Invalid signature");
        return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401, headers: { "Content-Type": "application/json" } });
      }
      console.log("[webhook] Signature valid");

      let payload: PaddleWebhookPayload;
      try {
        payload = JSON.parse(rawBody) as PaddleWebhookPayload;
      } catch {
        console.error("[webhook] Invalid JSON");
        return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      console.log("[webhook] Event type:", payload.event_type);
      if (payload.event_type !== "transaction.completed") {
        console.log("[webhook] Ignoring non-transaction.completed, returning 200");
        return new Response("OK", { status: 200 });
      }

      const data = payload.data;
      const transactionId =
        (data && typeof data === "object" && ("id" in data) && data.id) ||
        (data && typeof data === "object" && ("transaction_id" in data) && (data as { transaction_id?: string }).transaction_id) ||
        null;
      if (!transactionId || typeof transactionId !== "string") {
        console.error("[webhook] transaction.completed missing data.id; payload.data:", data);
        return new Response(JSON.stringify({ error: "Missing transaction id" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      console.log("[webhook] transaction.completed accepted, txn:", transactionId, "(processing in background)");

      // Respond 200 immediately; process in background
      ctx.waitUntil(processWebhook(request.url, rawBody, payload, env));
      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // GET /thankyou?txn=...&redirect=... (redirect = optional; when set, Worker can redirect to your success page with txn)
    if (method === "GET" && path === "/thankyou") {
      let txn = url.searchParams.get("txn");
      if (txn === "" || txn === "undefined" || txn === "null") txn = null;
      const redirect = url.searchParams.get("redirect");
      const baseUrl = new URL(request.url).origin;
      console.log("[thankyou] GET", { txn: txn ? tail4(txn) : null, hasRedirect: !!redirect });

      // No txn: Paddle may have redirected here before our JS ran. Show message and optional "Return to site".
      if (!txn) {
        console.log("[thankyou] No txn — showing email fallback");
        if (redirect) {
          return htmlResponse(
            `<h1>Thank you</h1><p>Your download link is on its way — check your email.</p><p><a href="${redirect}">Return to site</a></p>`,
            200
          );
        }
        return htmlResponse(
          `<h1>Thank you</h1><p>Your download link is on its way — check your email.</p><p>If you don't see it, check spam.</p>`,
          200
        );
      }

      const record = await env.DOWNLOADS_KV.get(`txn_${txn}`);
      const hasRecord = !!record;
      console.log("[thankyou] KV lookup txn_***:", hasRecord ? "found" : "not found");
      const downloadUrl = record
        ? `${baseUrl}/download?token=${encodeURIComponent((JSON.parse(record) as KVTransactionRecord).downloadToken)}`
        : "";

      // Send user to your success page with txn so the poller can show the download link.
      if (redirect) {
        console.log("[thankyou] Redirecting to success page with txn");
        const successUrl = redirect.includes("?") ? `${redirect}&txn=${encodeURIComponent(txn)}` : `${redirect}?txn=${encodeURIComponent(txn)}`;
        return htmlResponse(
          `<h1>Thank you</h1><p>Redirecting you to your download…</p><p>If you are not redirected, <a href="${successUrl}">click here</a>.</p><script>setTimeout(function(){ window.location.href = ${JSON.stringify(successUrl)}; }, 800);</script>`,
          200
        );
      }

      if (!record) {
        console.log("[thankyou] No record yet — showing check your email");
        return htmlResponse(
          `<h1>Thank you</h1><p>Your download link is on its way — check your email.</p><p>If you don't see it, check spam or refresh this page in a moment.</p>`,
          200
        );
      }
      const data = JSON.parse(record) as KVTransactionRecord;
      console.log("[thankyou] Showing download link on Worker page");
      return htmlResponse(
        `<h1>Thank you</h1><p><a href="${downloadUrl}">Download your purchase</a></p><p>You can also use the link we sent to your email.</p>`,
        200
      );
    }

    // GET /api/thankyou/status?txn=...
    if (method === "GET" && path === "/api/thankyou/status") {
      const txn = url.searchParams.get("txn");
      if (!txn) {
        console.warn("[status] Missing txn");
        return corsJsonResponse({ error: "Missing txn" }, 400);
      }
      const record = await env.DOWNLOADS_KV.get(`txn_${txn}`);
      const baseUrl = new URL(request.url).origin;
      if (!record) {
        console.log("[status] txn", tail4(txn), "— not ready");
        return corsJsonResponse({ ready: false }, 200);
      }
      const data = JSON.parse(record) as KVTransactionRecord;
      console.log("[status] txn", tail4(txn), "— ready, returning downloadUrl");
      return corsJsonResponse(
        { ready: true, downloadUrl: `${baseUrl}/download?token=${encodeURIComponent(data.downloadToken)}` },
        200
      );
    }

    // GET /download?token=...
    if (method === "GET" && path === "/download") {
      const token = url.searchParams.get("token");
      const debug = url.searchParams.get("debug") === "1";
      const debugJson = (obj: object, status: number) =>
        debug ? corsJsonResponse(obj, status) : null;
      console.log("[download] GET", { token: token ? tail4(token) : null, debug });

      if (!token) {
        console.warn("[download] Missing token");
        const res = debugJson({ error: "Missing token" }, 400);
        return res ?? htmlResponse("Missing token", 400);
      }
      const record = await env.DOWNLOADS_KV.get(`token_${token}`);
      if (!record) {
        console.warn("[download] Token not in KV (link not found or expired)");
        const res = debugJson({ error: "Link not found or expired", step: "token_lookup" }, 404);
        return res ?? htmlResponse("Link not found or expired.", 404);
      }
      const data = JSON.parse(record) as KVTokenRecord;
      if (new Date(data.expiresAt) < new Date()) {
        console.warn("[download] Link expired, expiresAt:", data.expiresAt);
        const res = debugJson({ error: "Link expired", step: "expiry_check", expiresAt: data.expiresAt }, 410);
        return res ?? htmlResponse("This download link has expired. Contact support for a new link.", 410);
      }
      console.log("[download] Token valid, r2Key:", data.r2Key);
      const object = await env.PRODUCTS_R2.get(data.r2Key);
      if (!object) {
        console.error("[download] R2 object not found; r2Key:", data.r2Key);
        const res = debugJson({ error: "File not found", step: "r2_get", r2Key: data.r2Key }, 404);
        return res ?? htmlResponse("File not found.", 404);
      }
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      const filename = data.r2Key.split("/").pop() || "download";
      headers.set("Content-Disposition", `attachment; filename="${filename}"`);
      headers.set("Cache-Control", "no-store");
      if (!headers.get("Content-Type") || headers.get("Content-Type")?.startsWith("text/")) {
        headers.set("Content-Type", "application/octet-stream");
      }
      for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
      console.log("[download] Serving file, filename:", filename);
      return new Response(object.body, { status: 200, headers });
    }

    console.log("[worker] No route matched:", method, path);
    return new Response("Not found", { status: 404 });
  },
};

async function processWebhook(
  requestUrl: string,
  _rawBody: string,
  payload: PaddleWebhookPayload,
  env: Env
): Promise<void> {
  console.log("[processWebhook] Start");
  const data = payload.data;
  const transactionId =
    (data && "id" in data && data.id) ||
    (data && "transaction_id" in data && (data as { transaction_id: string }).transaction_id) ||
    "";
  if (!transactionId) {
    console.error("[processWebhook] No transaction id in payload.data");
    return;
  }
  const baseUrl = new URL(requestUrl).origin;
  console.log("[processWebhook] txn:", transactionId);

  // Idempotency: already processed?
  const existing = await env.DOWNLOADS_KV.get(`txn_${transactionId}`);
  if (existing) {
    console.log("[processWebhook] Already processed (idempotent), skip");
    return;
  }

  const firstItem = data.items?.[0];
  const priceId = firstItem?.price?.id ?? firstItem?.product?.id;
  const customData = (data as { custom_data?: { download_path?: string } }).custom_data;
  const r2Key =
    customData?.download_path?.trim() ||
    (priceId ? PRICE_TO_R2_KEY[priceId] : undefined);
  console.log("[processWebhook] priceId:", priceId ?? "none", "custom_data.download_path:", customData?.download_path ?? "none", "r2Key:", r2Key ?? "none");
  if (!r2Key) {
    console.error("[processWebhook] No R2 key: no custom_data.download_path and no PRICE_TO_R2_KEY for price:", priceId);
    return;
  }

  const downloadToken = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + DOWNLOAD_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const txnRecord: KVTransactionRecord = { downloadToken, createdAt };
  const tokenRecord: KVTokenRecord = {
    productId: priceId ?? "",
    r2Key,
    expiresAt,
  };

  await env.DOWNLOADS_KV.put(`txn_${transactionId}`, JSON.stringify(txnRecord));
  await env.DOWNLOADS_KV.put(`token_${downloadToken}`, JSON.stringify(tokenRecord));
  console.log("[processWebhook] KV written: txn_***, token_***", tail4(downloadToken));

  const customerEmail = getCustomerEmail(data);
  console.log("[processWebhook] customer email:", customerEmail === "noreply@example.com" ? "missing (using fallback)" : "present");

  // Supabase: insert order
  try {
    console.log("[processWebhook] Supabase insert...");
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        transaction_id: transactionId,
        customer_email: customerEmail,
        items: data.items ?? [],
        download_token: downloadToken,
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

  const downloadUrl = `${baseUrl}/download?token=${downloadToken}`;

  // Resend: download link email (primary)
  try {
    console.log("[processWebhook] Resend download email...");
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: "New Opening Supply <onboarding@resend.dev>",
        to: [customerEmail],
        subject: "Your download is ready",
        html: `<p>Thanks for your purchase. Download your file here:</p><p><a href="${downloadUrl}">Download</a></p><p>This link expires in ${DOWNLOAD_EXPIRY_DAYS} days.</p>`,
      }),
    });
    if (!resendRes.ok) {
      const t = await resendRes.text();
      console.error("[processWebhook] Resend download email failed:", resendRes.status, t);
    } else {
      console.log("[processWebhook] Resend download email OK");
    }
  } catch (e) {
    console.error("[processWebhook] Resend error:", e);
  }

  // Resend: optional order summary (invoice-style)
  try {
    console.log("[processWebhook] Resend order confirmation...");
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: "New Opening Supply <onboarding@resend.dev>",
        to: [customerEmail],
        subject: "Order confirmation",
        html: `<p>Order confirmed. Transaction: ${transactionId}. Your download link has been sent in a separate email.</p>`,
      }),
    });
    console.log("[processWebhook] Resend order confirmation sent (best-effort)");
  } catch (e) {
    console.warn("[processWebhook] Resend order confirmation failed (non-critical):", e);
  }
  console.log("[processWebhook] Done, downloadUrl available for txn:", transactionId);
}

function htmlResponse(html: string, status: number): Response {
  return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>New Opening Supply</title></head><body>${html}</body></html>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function jsonResponse(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
