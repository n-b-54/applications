# New Opening Supply — Checkout Worker

Cloudflare Worker that handles Paddle checkout: unique download links (KV + R2), order records (Supabase), and emails (Resend).

**Linking Git, Cloudflare Workers, R2, and Supabase:** see **[CONNECT.md](CONNECT.md)** for step-by-step instructions.

## Routes

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/webhook/paddle` | Paddle webhook (transaction.completed): verify signature, store token in KV, insert order in Supabase, send Resend emails |
| GET | `/thankyou?txn=...` | Thank-you page; shows download link when ready |
| GET | `/api/thankyou/status?txn=...` | Poll for download link (returns `{ ready, downloadUrl }`) |
| GET | `/download?token=...` | Serve file from R2 using unique token |

## Setup

1. **Cloudflare**
   - Create a KV namespace (Workers & Pages → KV). Put its **id** in `wrangler.toml` under `kv_namespaces[0].id`.
   - Create an R2 bucket. Put its **name** in `wrangler.toml` under `r2_buckets[0].bucket_name`.
   - Upload your product file(s) to R2 (e.g. `products/your-product.zip`).

2. **Supabase**
   - Create a project. Run `supabase/orders.sql` in the SQL Editor.
   - In Settings → API, copy **Project URL** and **service_role** key.

3. **Paddle**
   - Create a product and price. Note the **price_id** (e.g. `pri_xxx`).
   - In Developer Tools → Notifications, create a webhook destination: URL = `https://YOUR_WORKER_URL/api/webhook/paddle`, subscribe to **transaction.completed**. Copy the **secret key**.

4. **Resend**
   - Verify your domain. Create an API key.
   - In `src/index.ts`, change the `from` address in both Resend calls from `onboarding@resend.dev` to your verified sender (e.g. `orders@yourdomain.com`).

5. **Product → file mapping**
   - In `src/types.ts`, add your Paddle price_id → R2 key in `PRICE_TO_R2_KEY`, e.g.:
   - `"pri_xxxxxxxxxxxxx": "products/your-product.zip"`

6. **Secrets**
   - Local: copy `.dev.vars.example` to `.dev.vars` and fill in values.
   - Production: `wrangler secret put PADDLE_WEBHOOK_SECRET` (and same for `RESEND_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).

7. **Deploy**
   - `npm install`
   - Replace KV id and R2 bucket name in `wrangler.toml`.
   - `npm run deploy`

## Webflow

- Add Paddle.js. On checkout open, set success URL to `https://YOUR_WORKER_URL/thankyou`.
- Use Paddle’s **checkout.completed** event to redirect with transaction id: `window.location = 'https://YOUR_WORKER_URL/thankyou?txn=' + data.transaction_id`.

## Local dev

- `npm run dev`
- Expose with a tunnel (e.g. Cloudflare Tunnel or Hookdeck) so Paddle can reach `/api/webhook/paddle`.
