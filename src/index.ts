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
  PADDLE_WEBHOOK_SECRET: string;
  RESEND_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

const DOWNLOAD_EXPIRY_DAYS = 30;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // POST /api/webhook/paddle — Paddle webhook
    if (method === "POST" && path === "/api/webhook/paddle") {
      const rawBody = await request.text();
      const signature = request.headers.get("Paddle-Signature");
      const valid = await verifyPaddleSignature(rawBody, signature, env.PADDLE_WEBHOOK_SECRET);
      if (!valid) return new Response("Invalid signature", { status: 401 });

      let payload: PaddleWebhookPayload;
      try {
        payload = JSON.parse(rawBody) as PaddleWebhookPayload;
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
      if (payload.event_type !== "transaction.completed") {
        return new Response("OK", { status: 200 });
      }

      const transactionId = payload.data?.id;
      if (!transactionId) return new Response("Missing transaction id", { status: 400 });

      // Respond 200 immediately; process in background
      ctx.waitUntil(processWebhook(request.url, rawBody, payload, env));
      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // GET /thankyou?txn=...
    if (method === "GET" && path === "/thankyou") {
      const txn = url.searchParams.get("txn");
      if (!txn) return htmlResponse("Missing transaction id", 400);
      const record = await env.DOWNLOADS_KV.get(`txn_${txn}`);
      if (!record) {
        return htmlResponse(
          `<h1>Thank you</h1><p>Your download link is on its way — check your email.</p><p>If you don't see it, check spam or refresh this page in a moment.</p>`,
          200
        );
      }
      const data = JSON.parse(record) as KVTransactionRecord;
      const baseUrl = new URL(request.url).origin;
      const downloadUrl = `${baseUrl}/download?token=${encodeURIComponent(data.downloadToken)}`;
      return htmlResponse(
        `<h1>Thank you</h1><p><a href="${downloadUrl}">Download your purchase</a></p><p>You can also use the link we sent to your email.</p>`,
        200
      );
    }

    // GET /api/thankyou/status?txn=...
    if (method === "GET" && path === "/api/thankyou/status") {
      const txn = url.searchParams.get("txn");
      if (!txn) return jsonResponse({ error: "Missing txn" }, 400);
      const record = await env.DOWNLOADS_KV.get(`txn_${txn}`);
      const baseUrl = new URL(request.url).origin;
      if (!record) {
        return jsonResponse({ ready: false }, 200);
      }
      const data = JSON.parse(record) as KVTransactionRecord;
      return jsonResponse({
        ready: true,
        downloadUrl: `${baseUrl}/download?token=${encodeURIComponent(data.downloadToken)}`,
      });
    }

    // GET /download?token=...
    if (method === "GET" && path === "/download") {
      const token = url.searchParams.get("token");
      if (!token) return htmlResponse("Missing token", 400);
      const record = await env.DOWNLOADS_KV.get(`token_${token}`);
      if (!record) return htmlResponse("Link not found or expired.", 404);
      const data = JSON.parse(record) as KVTokenRecord;
      if (new Date(data.expiresAt) < new Date()) {
        return htmlResponse("This download link has expired. Contact support for a new link.", 410);
      }
      const object = await env.PRODUCTS_R2.get(data.r2Key);
      if (!object) return htmlResponse("File not found.", 404);
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("Content-Disposition", `attachment; filename="${data.r2Key.split("/").pop() || "download"}"`);
      return new Response(object.body, { status: 200, headers });
    }

    return new Response("Not found", { status: 404 });
  },
};

async function processWebhook(
  requestUrl: string,
  _rawBody: string,
  payload: PaddleWebhookPayload,
  env: Env
): Promise<void> {
  const data = payload.data;
  const transactionId = data.id;
  const baseUrl = new URL(requestUrl).origin;

  // Idempotency: already processed?
  const existing = await env.DOWNLOADS_KV.get(`txn_${transactionId}`);
  if (existing) return;

  const firstItem = data.items?.[0];
  const priceId = firstItem?.price?.id ?? firstItem?.product?.id;
  const r2Key = priceId ? PRICE_TO_R2_KEY[priceId] : undefined;
  if (!r2Key) {
    console.error("No R2 key mapping for price/product:", priceId);
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

  const customerEmail = getCustomerEmail(data);

  // Supabase: insert order
  try {
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
      console.error("Supabase insert failed:", res.status, t);
    }
  } catch (e) {
    console.error("Supabase error:", e);
  }

  const downloadUrl = `${baseUrl}/download?token=${downloadToken}`;

  // Resend: download link email (primary)
  try {
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
      console.error("Resend download email failed:", resendRes.status, t);
    }
  } catch (e) {
    console.error("Resend error:", e);
  }

  // Resend: optional order summary (invoice-style)
  try {
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
  } catch {
    // Non-critical
  }
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
