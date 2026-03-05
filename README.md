# x402 Tollgate — Sample

A Cloudflare Worker that payment-gates content using the [x402 protocol](https://x402.org) and [Prism](https://prism-gw.fd.xyz) as the payment facilitator.

No upstream origin required — content is served directly by the worker after payment is verified and settled.

---

## How It Works

```
GET /premium/jokes/  (no X-Payment)
  → 402 with Prism payment options (network, asset, amount, payTo)

GET /premium/jokes/  (X-Payment: <base64 proof>)
  → decode proof
  → POST Prism /verify
  → POST Prism /settle
  → 200 with gated content
```

---

## Configuration

Edit `GATED_ROUTES` at the top of `src/index.js`:

```js
const GATED_ROUTES = {
  "/premium/jokes/": {
    price: 0.01,           // USD
    contentType: "application/json",
    content: JSON.stringify({ ... }),
  },
};
```

---

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars
# fill in PRISM_API_KEY in .dev.vars
```

## Local Development

```bash
npx wrangler dev
```

## Deployment

```bash
npx wrangler secret put PRISM_API_KEY
npx wrangler deploy
```

---

## Testing

```bash
# No payment → 402
curl -i https://<worker>.workers.dev/premium/jokes/

# With payment proof → 200
curl -i https://<worker>.workers.dev/premium/jokes/ \
  -H "X-Payment: <base64-encoded-proof>"
```
