# New Opening Supply — Checkout Worker (backend only)

This repo is the **backend only**: a Cloudflare Worker that handles Paddle checkout (webhook), unique download links (KV + R2), order records (Supabase), and emails (Resend). The frontend (e.g. Webflow) runs elsewhere and triggers this Worker by opening Paddle checkout and pointing success/redirect to this Worker’s URLs.

**Linking Git, Cloudflare Workers, R2, and Supabase:** see **[CONNECT.md](CONNECT.md)**.

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

### R2 setup (checklist)

The Worker serves files from the R2 bucket named in `wrangler.toml` (`r2_buckets[0].bucket_name`). The **object key** it looks up is either:

- **From Paddle:** `custom_data.download_path` (e.g. what you set in Webflow as “Download Path”), or  
- **Fallback:** `PRICE_TO_R2_KEY[price_id]` in `src/types.ts`.

To make sure R2 is set up correctly:

1. **Create the bucket** (if needed)  
   - Cloudflare Dashboard → **R2** → **Create bucket**.  
   - Name it exactly what you have in `wrangler.toml` (e.g. `new-opening-supply`).

2. **Upload files with the right keys**  
   - Object keys must **exactly** match what the Worker will request:  
     - If you use Webflow “Download Path”, upload the file with that key (e.g. `New Opening Products/Brand Guidelines Download Text.zip`).  
     - If you use `PRICE_TO_R2_KEY`, upload with the value you put there (e.g. `products/your-product.zip`).  
   - Keys are **case-sensitive** and can include slashes (folders). Do **not** use a leading slash (e.g. use `products/file.zip`, not `/products/file.zip`).

3. **Verify in the dashboard**  
   - R2 → your bucket → **Objects**.  
   - Confirm each product file is listed with the exact key you use in Webflow or in `PRICE_TO_R2_KEY`.

4. **Connect the bucket to the Worker**  
   - In `wrangler.toml`, `r2_buckets[0].bucket_name` must match the bucket name.  
   - Redeploy after any change.

**Quick test:** After a successful purchase, open the download URL in the browser. If you see “File not found”, the token/KV path is correct but the R2 key for that order doesn’t match an object in the bucket—double-check the key in KV (from the webhook) and that an object with that key exists in R2.

## Triggering this Worker (e.g. from Webflow)

Any frontend that can open Paddle checkout can trigger this Worker:

1. **Webhook:** Configure Paddle to send `transaction.completed` to `https://YOUR_WORKER_URL/api/webhook/paddle`.
2. **Thank-you / redirect:** When opening checkout, set the success URL to `https://YOUR_WORKER_URL/thankyou`. After payment, redirect the user to that URL with the transaction ID: `https://YOUR_WORKER_URL/thankyou?txn=TRANSACTION_ID` (e.g. from Paddle’s `checkout.completed` event). The Worker then shows the download link or “check your email.”

### Webflow: CMS fields and code

**1. CMS collection fields (e.g. Products)**

Create these fields and use them in your template:

| Field name        | Type   | Use |
|-------------------|--------|-----|
| Paddle Price ID   | Plain Text | Paddle price id, e.g. `pri_01xxx` |
| Product SKU       | Plain Text | Internal SKU (sent to Paddle customData) |
| Download Path     | Plain Text | R2 object key for this product, e.g. `products/my-file.zip` |
| Redirect          | Plain Text | Full URL of your Webflow success page for this product (e.g. `https://yoursite.com/thank-you` or a collection-based URL) |

**2. Product/collection page: Buy button + Paddle (paste in Custom Code or embed)**

Replace `YOUR_CLIENT_SIDE_TOKEN` and `YOUR_WORKER_URL` (e.g. `https://new-opening-supply.<subdomain>.workers.dev`). Load Paddle.js once in Head; put the script in Footer or before `</body>`.

- Give your **Buy now** button the class **`paddle-buy`**.
- On that same button (or its parent collection item wrapper), add **custom attributes** and bind each value to your CMS field via the Webflow field picker:

  - `data-price-id` → Paddle Price ID  
  - `data-sku` → Product SKU  
  - `data-product-name` → Name (or product name field)  
  - `data-download-path` → Download Path  
  - `data-redirect` → Redirect (this is the post-purchase redirect URL; when set, it is used instead of the Worker thank-you page)

**Sandbox (testing):** Use `paddle.sandbox.js` and a `test_` token; set `Paddle.Environment.set("sandbox")`. **Live:** Use `paddle.js` and a `live_` token; remove the Environment.set line.

```html
<!-- Put both blocks in Head code so Paddle loads before the script runs. Sandbox: paddle.sandbox.js. Live: paddle.js and remove Environment.set("sandbox"). -->
<script src="https://cdn.paddle.com/paddle/v2/paddle.sandbox.js"></script>
<script>
(function() {
  var WORKER_URL = 'YOUR_WORKER_URL';
  Paddle.Environment.set("sandbox");
  console.log('[Paddle] Sandbox environment set');

  Paddle.Initialize({
    token: 'YOUR_CLIENT_SIDE_TOKEN',
    eventCallback: function(data) {
      console.log('[Paddle] Event:', data.name, data);
      if (data.name === 'checkout.completed' && data.data) {
        var txn = data.data.transaction_id || data.data.id || data.transaction_id;
        var redirectUrl = sessionStorage.getItem('paddle_redirect_url');
        sessionStorage.removeItem('paddle_redirect_url');
        console.log('[Paddle] Checkout completed, txn:', txn, 'redirect:', redirectUrl, 'full data:', data.data);
        if (!txn) {
          console.warn('[Paddle] No transaction ID in event — check Paddle docs for payload. Redirecting to Worker.');
        }
        var workerThankYou = WORKER_URL + '/thankyou?txn=' + encodeURIComponent(txn || '') + '&redirect=' + encodeURIComponent(redirectUrl || '');
        window.location = workerThankYou;
      }
    }
  });
  console.log('[Paddle] Initialized');

  document.addEventListener('click', function(e) {
    var btn = e.target.closest('.paddle-buy');
    if (!btn) return;
    e.preventDefault();
    var priceId = (btn.getAttribute('data-price-id') || '').trim();
    if (!priceId) {
      console.error('[Paddle] Buy button has no data-price-id. Add the attribute and bind it to your CMS Paddle Price ID.');
      return;
    }
    var redirect = (btn.getAttribute('data-redirect') || '').trim();
    if (redirect) sessionStorage.setItem('paddle_redirect_url', redirect);
    var successUrl = WORKER_URL + '/thankyou?redirect=' + encodeURIComponent(redirect || '');
    console.log('[Paddle] Opening checkout, priceId:', priceId, 'successUrl (Worker):', successUrl);
    try {
      Paddle.Checkout.open({
        items: [{ priceId: priceId, quantity: 1 }],
        customData: {
          sku: (btn.getAttribute('data-sku') || '').trim(),
          product_name: (btn.getAttribute('data-product-name') || '').trim(),
          download_path: (btn.getAttribute('data-download-path') || '').trim()
        },
        settings: { successUrl: successUrl }
      });
    } catch (err) {
      console.error('[Paddle] Checkout.open failed:', err);
    }
  });
})();
</script>
```

**Sandbox test card (do not use a real card):** In sandbox checkout use Paddle's test card, e.g. card number `4242 4242 4242 4242`, any future expiry, CVC `100`. See Paddle docs for full test details. Your bank will reject a real card in sandbox.

**3. Success page: show unique download link (paste on your Webflow success/thank-you page)**

On the page you redirect to after purchase (e.g. `/purchase/brand-guidelines-starter-kit`), add **both**:

1. A **div** with id `paddle-success-message` (the script will put the download link or status text here).
2. The **script** below. Replace `YOUR_WORKER_URL` with your Worker URL (e.g. `https://new-opening-supply.nick-builddigital.workers.dev`).

The script reads `?txn=...` from the URL, polls your Worker every 2 seconds until the download is ready, then shows the link. If there is no `txn` in the URL or the fetch fails, it shows "Check your email for the download link."

**Why you might see `txn: null`:** The product-page script now sends Paddle’s success URL to the **Worker** (`/thankyou?redirect=...`), not directly to this Webflow page. When checkout completes, the script redirects to the Worker with `txn` and `redirect`; the Worker then redirects here with `?txn=...`. If you still see `txn: null`, Paddle may be redirecting before the script runs — ensure the product page uses the **updated** script (successUrl = Worker URL with `?redirect=...`) and that you see `[Paddle] Checkout completed, txn: ...` in the **product page** console before the redirect.

```html
<div id="paddle-success-message">Preparing your download…</div>
<script>
(function() {
  var WORKER_URL = 'YOUR_WORKER_URL';
  var params = new URLSearchParams(window.location.search);
  var txn = params.get('txn');
  var el = document.getElementById('paddle-success-message');
  console.log('[Success page] txn:', txn, 'WORKER_URL:', WORKER_URL);
  if (!txn || !el) {
    console.log('[Success page] No txn in URL or no #paddle-success-message — showing email fallback');
    if (el) el.textContent = 'Thank you for your purchase. Check your email for the download link.';
    return;
  }
  function poll() {
    var url = WORKER_URL + '/api/thankyou/status?txn=' + encodeURIComponent(txn);
    console.log('[Success page] Polling:', url);
    fetch(url)
      .then(function(r) { return r.json(); })
      .then(function(d) {
        console.log('[Success page] Status response:', d);
        if (d.ready && d.downloadUrl) {
          console.log('[Success page] Download ready:', d.downloadUrl);
          var debugUrl = d.downloadUrl + (d.downloadUrl.indexOf('?') >= 0 ? '&' : '?') + 'debug=1';
          el.innerHTML = 'Your download is ready: <a id="paddle-download-link" href="' + d.downloadUrl + '" download target="_blank" rel="noopener">Download</a> <a id="paddle-download-debug" href="' + debugUrl + '" target="_blank" rel="noopener" style="font-size:0.85em;color:#666;">(debug)</a>';
          var link = document.getElementById('paddle-download-link');
          var debugLink = document.getElementById('paddle-download-debug');
          if (link) {
            link.addEventListener('click', function() {
              console.log('[Success page] Download clicked, href:', link.href);
            });
          }
          if (debugLink) {
            debugLink.addEventListener('click', function() {
              console.log('[Success page] Debug link clicked, href:', debugLink.href, '— opens JSON response in new tab');
            });
          }
          return;
        }
        setTimeout(poll, 2000);
      })
      .catch(function(err) {
        console.error('[Success page] Poll failed:', err);
        el.textContent = 'Thank you for your purchase. Check your email for the download link.';
      });
  }
  poll();
})();
</script>
```

**Flow summary:** Customer clicks Buy now → Paddle checkout (price ID, SKU, product name, download path from CMS) → Pays → Redirected to your success URL with `?txn=...` → Webhook hits Worker → Worker stores token, writes Supabase, sends Resend invoice + download email, uses **download_path** from customData as the R2 key for the file → Success page polls Worker and shows the unique download link when ready.

## Debugging downloads

If the file doesn’t download, use these steps to see where it fails.

1. **Add `?debug=1` to the download URL**  
   Open: `https://YOUR_WORKER_URL/download?token=THE_TOKEN&debug=1`  
   The response will be JSON instead of the file. It tells you:
   - `"error": "Link not found or expired"` → Token invalid or not in KV (webhook may not have run, or wrong URL).
   - `"error": "Link expired"` → Token exists but is past `expiresAt`; use a fresh purchase or extend expiry in code.
   - `"error": "File not found", "r2Key": "New Opening Products/..."` → Token and KV are fine; R2 has no object with that key. **Fix:** In R2, ensure an object exists with that **exact** key (same spelling, case, slashes). In Webflow, ensure “Download Path” matches that key exactly.

2. **Check Cloudflare Workers logs**  
   Dashboard → Workers & Pages → your Worker → Logs (or Real-time Logs). Look for `[download] R2 object not found; r2Key: ...` to see which key was requested when R2 returned nothing.

3. **Check the normal download in the Network tab**  
   Open DevTools → Network, click the download link (without `debug=1`). Check: status (200 = file served, 404 = token or R2 issue), response headers (`Content-Disposition: attachment` should be present). If status is 200 but the browser doesn’t download, the response may be cached or the link may be same-tab; try a hard refresh or open in new tab.

4. **Confirm webhook and custom_data**  
   If the download link never appears or token is always “not found”, the webhook may not be receiving `transaction.completed` or Paddle may not be sending `custom_data.download_path`. In Paddle Developer Tools → Notifications, confirm the webhook URL and that checkout is opened with `customData: { download_path: "..." }` (e.g. from `data-download-path` in Webflow).

5. **"Missing transaction id" or blank page after checkout**  
   If you are **redirected to a blank page** that only shows "Missing transaction id", your **checkout success URL is set to the webhook URL** by mistake. Paddle must not redirect customers to `/api/webhook/paddle`. The success URL must be the Worker **thank-you** URL: `https://YOUR_WORKER_URL/thankyou?redirect=YOUR_WEBFLOW_SUCCESS_PAGE`. In the product-page script in this README, `successUrl` must be `WORKER_URL + '/thankyou?redirect=' + encodeURIComponent(redirect || '')` — never the webhook URL. Fix that in Webflow and redeploy; after payment customers should land on the Worker thank-you page, which then redirects to your success page with `?txn=...`.  
   If the message appears in **Paddle’s webhook logs** (not in the browser), it means the webhook payload has no `data.id` (the Worker also accepts `data.transaction_id`); check the payload in Paddle Developer Tools → Notifications → your webhook → recent deliveries.

## Logging and debugging (Worker)

The Worker logs to **console** with consistent prefixes so you can filter in Cloudflare:

| Prefix | Route / step | What to look for |
|--------|----------------|------------------|
| `[webhook]` | POST /api/webhook/paddle | Request received, signature valid, event type, transaction accepted or error |
| `[processWebhook]` | Background after webhook | txn, idempotency skip, priceId / download_path / r2Key, KV written, Supabase and Resend success/fail, Done |
| `[thankyou]` | GET /thankyou | txn present or not, KV lookup result, redirect to success page or show link |
| `[status]` | GET /api/thankyou/status | txn, ready or not ready |
| `[download]` | GET /download | token present, KV hit/miss, expiry, r2Key, R2 hit/miss, serving file |
| `[worker]` | No route matched | method and path for 404s |

**Where to view logs:** Cloudflare Dashboard → Workers & Pages → your Worker → **Logs** (or **Real-time Logs**). Use the search/filter to match a prefix (e.g. `[processWebhook]`) or a transaction id. Tokens and IDs are redacted to the last 4 characters in logs (e.g. `****abc1`).

**Typical flow when everything works:**  
`[webhook] Request received` → `Signature valid` → `transaction.completed accepted` → `[processWebhook] Start` → `r2Key: ...` → `KV written` → `Supabase insert OK` → `Resend download email OK` → `Done`. Then on the success page: `[status] not ready` (a few times) → `[status] ready, returning downloadUrl`. When they click download: `[download] GET` → `Token valid, r2Key: ...` → `Serving file`.

## Local dev

- `npm run dev`
- Expose with a tunnel (e.g. Cloudflare Tunnel or Hookdeck) so Paddle can reach `/api/webhook/paddle`.
