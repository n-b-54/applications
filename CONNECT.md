# Connect: Git, Cloudflare Workers, R2, and Supabase

Follow these steps to link your repo to GitHub, deploy the Worker, and connect R2 and Supabase.

---

## 1. Git and GitHub

Repo is already initialized. To push to GitHub:

1. **Create a new repository on GitHub**
   - Go to [github.com/new](https://github.com/new).
   - Name it (e.g. `new-opening-supply`). Do **not** add a README or .gitignore (you already have them).
   - Create the repo.

2. **Add remote and push** (replace `YOUR_USERNAME` and `YOUR_REPO` with your GitHub user and repo name):

   ```bash
   cd "/Users/nickbunting/Documents/Nick Applications/new-opening-supply"
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git branch -M main
   git push -u origin main
   ```

   If you use SSH: `git remote add origin git@github.com:YOUR_USERNAME/YOUR_REPO.git`

---

## 2. Cloudflare: KV and R2

You need a **KV namespace** and an **R2 bucket** bound to the Worker.

### Option A — Create via Cloudflare Dashboard

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages**.
2. **KV**
   - Click **KV** in the left sidebar → **Create namespace**.
   - Name it (e.g. `DOWNLOADS`). Copy the **Namespace ID** (e.g. `abc123...`).
3. **R2**
   - Click **R2** in the left sidebar → **Create bucket**.
   - Name it (e.g. `new-opening-supply-products`). Copy the **bucket name**.

### Option B — Create via Wrangler (requires `wrangler login` first)

```bash
cd "/Users/nickbunting/Documents/Nick Applications/new-opening-supply"
npx wrangler login
npx wrangler kv namespace create DOWNLOADS
npx wrangler r2 bucket create new-opening-supply-products
```

- The KV command prints an **id** — use that in `wrangler.toml`.
- The R2 bucket name is `new-opening-supply-products`.

### Update wrangler.toml

Open `wrangler.toml` and replace the placeholders:

- `kv_namespaces[0].id` → your KV namespace ID (from dashboard or `kv namespace create` output).
- `r2_buckets[0].bucket_name` → your R2 bucket name (e.g. `new-opening-supply-products`).

Example:

```toml
kv_namespaces = [
  { binding = "DOWNLOADS_KV", id = "abc123def456789" }
]
r2_buckets = [
  { binding = "PRODUCTS_R2", bucket_name = "new-opening-supply-products" }
]
```

### Upload a product file to R2

- In Cloudflare Dashboard: **R2** → your bucket → **Upload** (e.g. `products/your-product.zip`).
- Or use the R2 API / S3-compatible API if you prefer. The key must match what you put in `PRICE_TO_R2_KEY` in `src/types.ts`.

---

## 3. Cloudflare Workers (deploy)

1. **Install and log in** (if you haven’t):

   ```bash
   npm install
   npx wrangler login
   ```

2. **Set secrets** (Worker will use these at runtime):

   ```bash
   npx wrangler secret put PADDLE_WEBHOOK_SECRET
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put SUPABASE_URL
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   ```

   Enter each value when prompted. Get them from Paddle, Resend, and Supabase (see below).

3. **Deploy**:

   ```bash
   npm run deploy
   ```

   Note the Worker URL (e.g. `https://new-opening-supply.<your-subdomain>.workers.dev`).

### Optional: Connect GitHub for automatic deploys

- In Cloudflare Dashboard: **Workers & Pages** → **Create** → **Connect to Git**.
- Select your GitHub repo and branch. Cloudflare will build and deploy on push. You still need to add the same **secrets** in the dashboard (Settings → Variables and Secrets) and ensure **KV** and **R2** bindings are added to the Worker in the dashboard (Settings → Variables → KV / R2).

---

## 4. Supabase

1. **Create a project**
   - Go to [supabase.com](https://supabase.com) → **New project**.
   - Pick org, name, password, region. Create.

2. **Create the orders table**
   - In the project: **SQL Editor** → **New query**.
   - Paste the contents of `supabase/orders.sql` and run it.

3. **Get URL and key**
   - **Settings** (gear) → **API**.
   - Copy **Project URL** (e.g. `https://xxxxx.supabase.co`).
   - Under **Project API keys**, copy the **service_role** key (secret; used by the Worker).

4. **Connect the Worker**
   - Use the same URL and key when you run:
     ```bash
     npx wrangler secret put SUPABASE_URL
     npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
     ```

---

## 5. Checklist

- [ ] Git repo pushed to GitHub (remote added, `git push`).
- [ ] KV namespace created; its **id** in `wrangler.toml`.
- [ ] R2 bucket created; its **name** in `wrangler.toml`.
- [ ] Product file uploaded to R2; key added to `PRICE_TO_R2_KEY` in `src/types.ts`.
- [ ] Supabase project created; `supabase/orders.sql` run; **Project URL** and **service_role** set as Worker secrets.
- [ ] Paddle webhook secret, Resend API key set as Worker secrets.
- [ ] `npm run deploy` successful; Paddle webhook URL set to `https://YOUR_WORKER_URL/api/webhook/paddle`.
