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

```html
<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>
<script>
(function() {
  var WORKER_URL = 'YOUR_WORKER_URL';

  Paddle.Initialize({
    token: 'YOUR_CLIENT_SIDE_TOKEN',
    eventCallback: function(data) {
      if (data.name === 'checkout.completed' && data.data && data.data.transaction_id) {
        var txn = data.data.transaction_id;
        var redirectUrl = sessionStorage.getItem('paddle_redirect_url');
        sessionStorage.removeItem('paddle_redirect_url');
        if (redirectUrl) {
          var sep = redirectUrl.indexOf('?') >= 0 ? '&' : '?';
          window.location = redirectUrl + sep + 'txn=' + encodeURIComponent(txn);
        } else {
          window.location = WORKER_URL + '/thankyou?txn=' + encodeURIComponent(txn);
        }
      }
    }
  });

  document.addEventListener('click', function(e) {
    var btn = e.target.closest('.paddle-buy');
    if (!btn) return;
    e.preventDefault();
    var priceId = (btn.getAttribute('data-price-id') || '').trim();
    if (!priceId) return;
    var redirect = (btn.getAttribute('data-redirect') || '').trim();
    if (redirect) sessionStorage.setItem('paddle_redirect_url', redirect);
    Paddle.Checkout.open({
      items: [{ priceId: priceId, quantity: 1 }],
      customData: {
        sku: (btn.getAttribute('data-sku') || '').trim(),
        product_name: (btn.getAttribute('data-product-name') || '').trim(),
        download_path: (btn.getAttribute('data-download-path') || '').trim()
      },
      settings: {
        successUrl: redirect ? redirect : (WORKER_URL + '/thankyou')
      }
    });
  });
})();
</script>
```

**3. Success page: show unique download link (paste on your Webflow success/thank-you page)**

This reads `?txn=...` from the URL, polls your Worker until the download is ready, then shows the link. Replace `YOUR_WORKER_URL` with the same value as above.

```html
<div id="paddle-success-message">Preparing your download…</div>
<script>
(function() {
  var WORKER_URL = 'YOUR_WORKER_URL';
  var params = new URLSearchParams(window.location.search);
  var txn = params.get('txn');
  var el = document.getElementById('paddle-success-message');
  if (!txn || !el) {
    if (el) el.textContent = 'Thank you for your purchase. Check your email for the download link.';
    return;
  }
  function poll() {
    fetch(WORKER_URL + '/api/thankyou/status?txn=' + encodeURIComponent(txn))
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.ready && d.downloadUrl) {
          el.innerHTML = 'Your download is ready: <a href="' + d.downloadUrl + '" target="_blank" rel="noopener">Download</a>';
          return;
        }
        setTimeout(poll, 2000);
      })
      .catch(function() {
        el.textContent = 'Thank you for your purchase. Check your email for the download link.';
      });
  }
  poll();
})();
</script>
```

**Flow summary:** Customer clicks Buy now → Paddle checkout (price ID, SKU, product name, download path from CMS) → Pays → Redirected to your success URL with `?txn=...` → Webhook hits Worker → Worker stores token, writes Supabase, sends Resend invoice + download email, uses **download_path** from customData as the R2 key for the file → Success page polls Worker and shows the unique download link when ready.

## Local dev

- `npm run dev`
- Expose with a tunnel (e.g. Cloudflare Tunnel or Hookdeck) so Paddle can reach `/api/webhook/paddle`.
