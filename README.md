# New Opening Supply — Checkout Worker

Cloudflare Worker that receives Paddle `transaction.completed` webhooks, sends download emails (Resend), and records purchases (Supabase). Files are served from R2 via secure, expiring download tokens.

**Hosted checkout** handles the customer-facing checkout and redirect. This Worker runs in the background -- no frontend code needed on your site.

**Linking Git, Cloudflare Workers, R2, and Supabase:** see **[CONNECT.md](CONNECT.md)**.

## How it works

```
Customer clicks hosted checkout link on your site
       ↓
Paddle hosted checkout (payment)
       ↓
Paddle redirects customer to your success page (configured in Paddle)
       ↓  (in parallel)
Paddle fires transaction.completed webhook → this Worker
       ↓
Worker reads download_path from product custom_data
       ↓
Worker inserts purchase record into Supabase
       ↓
Worker sends download email via Resend (secure R2 link)
```

## Routes

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/webhook/paddle` | Paddle webhook: verify signature, record purchase in Supabase, send download email via Resend |
| GET | `/download?token=...` | Serve file from R2 using unique, expiring token |

## Per-product setup (3 minutes)

For each new product, you do three things:

| Step | What | Where | Time |
|------|------|-------|------|
| 1 | Upload file to R2 | CLI: `npm run upload -- my-product ./file.zip` | 30 sec |
| 2 | Create product in Paddle with `custom_data.download_path` | Paddle dashboard | 2 min |
| 3 | Paste hosted checkout link on your site | Webflow (or any site) | 30 sec |

No code changes. No redeployment.

### Step 1: Upload file to R2

```bash
npm run upload -- my-product ./file.zip
# Uploads to R2 key: products/my-product.zip

# Or use a full path:
npm run upload -- "New Opening Products/file.zip" ./file.zip
```

### Step 2: Create product in Paddle

1. Go to **Paddle Dashboard > Catalog > Products > Create product**
2. Set the product name, description, tax category
3. In the **Custom Data** field, add:

```json
{
  "download_path": "my-product"
}
```

This must match the slug you used in step 1. If you used a full path, use the full path here too (e.g. `"New Opening Products/file.zip"`).

4. Create a **price** for the product (one-time, set your amount)
5. Create a **hosted checkout** for that price, or copy the checkout link

### Step 3: Paste checkout link on your site

On your Webflow product page (or any page), add a button/link with the hosted checkout URL:

```html
<a href="https://checkout.paddle.com/...your-hosted-checkout-link...">Buy Now</a>
```

That's it. No JavaScript, no Paddle.js, no custom attributes.

## One-time setup

### 1. Cloudflare

- Create a KV namespace (Workers & Pages > KV). Put its **id** in `wrangler.toml` under `kv_namespaces[0].id`.
- Create an R2 bucket. Put its **name** in `wrangler.toml` under `r2_buckets[0].bucket_name`.

### 2. Supabase

- Create a project. Run `supabase/purchases.sql` in the SQL Editor.
- In Settings > API, copy **Project URL** and **service_role** key.

### 3. Paddle

- In Developer Tools > Notifications, create a webhook destination:
  - URL: `https://YOUR_WORKER_URL/api/webhook/paddle`
  - Subscribe to: **transaction.completed**
  - Copy the **secret key**
- For each product, add `custom_data` with `download_path` (see per-product setup above)

### 4. Resend

- Verify your domain. Create an API key.
- In `src/index.ts`, change the `from` address from `onboarding@resend.dev` to your verified sender (e.g. `orders@yourdomain.com`).

### 5. Secrets

```bash
# Local development
cp .dev.vars.example .dev.vars  # fill in values

# Production
wrangler secret put PADDLE_WEBHOOK_SECRET
wrangler secret put RESEND_API_KEY
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

### 6. Deploy

```bash
npm install
npm run deploy
```

## R2 setup (checklist)

The Worker serves files from the R2 bucket named in `wrangler.toml`. The object key comes from the product's `custom_data.download_path` in Paddle:

- Simple slug (e.g. `my-product`) -- Worker expands to `products/my-product.zip`
- Full path (e.g. `New Opening Products/file.zip`) -- used as-is

Upload files with `npm run upload -- <slug> <filepath>`.

To verify R2 is set up correctly:

1. **Bucket exists** -- Cloudflare Dashboard > R2 > confirm your bucket is listed
2. **File uploaded with correct key** -- R2 > your bucket > Objects > confirm the file key matches the slug/path
3. **Bucket connected to Worker** -- `wrangler.toml` `r2_buckets[0].bucket_name` matches the bucket name
4. **Keys are case-sensitive** -- `my-product` and `My-Product` are different keys

## Where does download_path come from?

The Worker checks three locations in the webhook payload (in order):

1. **Product-level**: `data.items[0].product.custom_data.download_path` -- set once in Paddle dashboard
2. **Price-level**: `data.items[0].price.custom_data.download_path` -- alternative location
3. **Transaction-level**: `data.custom_data.download_path` -- backward compat (e.g. from Paddle.js customData)

For hosted checkout, use option 1: set `custom_data` on the product itself.

## Debugging

### Download not working?

1. **Add `?debug=1` to the download URL** -- returns JSON instead of the file:
   - `"Link not found or expired"` -- token invalid or webhook hasn't run yet
   - `"Link expired"` -- token past expiry date
   - `"File not found"` + `r2Key` -- R2 has no object with that key; check the slug matches

2. **Check Worker logs** -- Cloudflare Dashboard > Workers & Pages > your Worker > Logs. Look for `[processWebhook]` entries to see what `download_path` and `r2Key` the Worker received.

3. **Check Paddle webhook deliveries** -- Paddle Developer Tools > Notifications > your webhook > recent deliveries. Confirm `transaction.completed` is being sent and the product's `custom_data` includes `download_path`.

### Log prefixes

| Prefix | What |
|--------|------|
| `[webhook]` | Signature verification, event type, transaction ID |
| `[processWebhook]` | Product info, download_path, KV write, Supabase insert, Resend email |
| `[download]` | Token lookup, R2 file serving |
| `[worker]` | Unmatched routes (404s) |

**Typical successful flow:**
`[webhook] Request received` > `Signature valid` > `transaction.completed` > `[processWebhook] Start` > `Supabase insert OK` > `Resend email sent OK` > `Done`

## Local dev

```bash
npm run dev
# Expose with a tunnel (e.g. Cloudflare Tunnel or Hookdeck) so Paddle can reach /api/webhook/paddle
```
