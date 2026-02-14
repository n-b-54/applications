/**
 * Verify Paddle webhook signature.
 * Payload: ts + ":" + raw body; HMAC-SHA256 with secret; compare to h1.
 * See: https://developer.paddle.com/webhooks/signature-verification
 */
export async function verifyPaddleSignature(
  rawBody: string,
  paddleSignature: string | null,
  secret: string
): Promise<boolean> {
  if (!paddleSignature) return false;
  const parts: Record<string, string> = {};
  for (const part of paddleSignature.split(";")) {
    const [k, v] = part.split("=");
    if (k && v) parts[k.trim()] = v.trim();
  }
  const ts = parts["ts"];
  const h1 = parts["h1"];
  if (!ts || !h1) return false;

  // Reject old events (replay tolerance ~5 minutes)
  const tsNum = parseInt(ts, 10);
  if (Number.isNaN(tsNum)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsNum) > 300) return false;

  const signedPayload = ts + ":" + rawBody;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signedPayload)
  );
  const expectedH1 = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (expectedH1.length !== h1.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedH1.length; i++) diff |= expectedH1.charCodeAt(i) ^ h1.charCodeAt(i);
  return diff === 0;
}
