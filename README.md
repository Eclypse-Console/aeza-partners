# Aeza Partner

Shopify app that connects brand stores to the Aeza marketplace. Every brand
gets its **own private Shopify app** (custom distribution, its own client id
and secret), and all of those apps point at this one deployment
(`https://aeza-partners.vercel.app`). Store credentials live encrypted in the
`ShopifyStore` table; there is no shared `SHOPIFY_API_KEY`/`SECRET`.

## What it does

| Flow | Where |
|---|---|
| Per-store auth (each request is verified with that store's own secret) | `app/shopify.server.ts` |
| Tokens and client secrets encrypted at rest (AES-256-GCM) | `app/lib/crypto.server.ts`, `app/lib/session-storage.server.ts` |
| On install: store marked connected, full catalog sync starts | `app/services/store.server.ts` |
| Full sync via Shopify Bulk Operations (any catalog size) | `app/services/product-sync.server.ts` |
| Live updates: products, stock, orders, fulfillments, uninstall | `app/routes/webhooks.events.tsx`, `webhooks.app.uninstalled.tsx` |
| Duplicate webhooks processed once (`WebhookEvent`) | `app/services/webhooks.server.ts` |
| Product picker: "all products" or "only selected" | dashboard, `app/routes/app.products.*` |
| Order creation for the main backend | `POST /api/orders` (`app/services/orders.server.ts`) |
| Nightly re-sync of every connected store | `GET /api/cron/resync` (`vercel.json`) |
| Sending products to the main Aeza catalog (**stub for now**) | `app/services/aeza-catalog.server.ts` |

A product is **live on Aeza** only when it's published, `ACTIVE` in Shopify
and not deleted.

## Environment variables (Vercel)

| Name | Purpose |
|---|---|
| `DATABASE_URL` | Neon **pooled** URL. Used by the app at runtime. |
| `DIRECT_URL` | Neon **direct** URL (host without `-pooler`) with `&schema=shopify_connector`. Used only by `prisma migrate`. |
| `SHOPIFY_APP_URL` | `https://aeza-partners.vercel.app` |
| `SCOPES` | `read_products,read_inventory,read_locations,read_orders,write_orders,read_fulfillments` (must match the toml template) |
| `ENCRYPTION_KEY` | 32 random bytes, base64: `openssl rand -base64 32`. See the warning below. |
| `MAIN_BACKEND_API_KEY` | Bearer token the main Aeza backend sends to `POST /api/orders`. Long random string. |
| `CRON_SECRET` | Vercel sends it as a Bearer token to the cron route. Long random string. |
| `AEZA_SYNC_MODE` | `off` (default, no-op) or `log` (logs every catalog change it would send to Aeza). |

`SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` are **not used**, including in local
dev: register your dev store with `store:add` like any brand.

### Operational warnings

- **`ENCRYPTION_KEY` must be backed up.** It encrypts every store's client
  secret and every access/refresh token. It must be identical in every
  environment that shares a database (Vercel and wherever you run
  `store:add`). If it's lost or changed, nothing stored can be decrypted:
  every store has to be re-registered with `store:add` and reinstall the app.
- **Migrations: Neon branch first, never production directly.** Create a
  Neon branch, point `DATABASE_URL`/`DIRECT_URL` at it, run
  `npx prisma migrate deploy` and test. Then apply the same migrations to
  production. Never run `prisma migrate dev` or `prisma migrate reset`
  against a shared database: they can drop data. Migrations are not run
  automatically on deploy; run `npx prisma migrate deploy` before deploying
  code that needs them.
- Every app's Dev Dashboard needs **protected customer data** access
  (name, email, phone, address) or `orderCreate` and the order webhooks fail.

## Add a brand

1. **Create the app.** In the Shopify Dev Dashboard create a new app for the
   brand (e.g. "Aeza Partner - Brand X"). Copy its client id and secret.
2. **Register it** (from `aeza-test-connector/`, with `.env` pointing at the
   right database and the production `ENCRYPTION_KEY`):

   ```
   npm run store:add -- --shop brandx.myshopify.com --client-id <client id> --brand-name "Brand X"
   ```

   It prompts for the secret (hidden), or reads `STORE_CLIENT_SECRET`. It
   writes the encrypted `ShopifyStore` row and `shopify.app.brandx.toml`.
   Use `--update` to rotate the secret later.
3. **Push the config** (URLs, scopes, webhooks) to that app:

   ```
   npx shopify app deploy --config brandx
   ```

4. **Distribution.** In the Dev Dashboard, set the app's distribution to
   **Custom distribution** and enter the brand's store domain
   (`brandx.myshopify.com`). Request protected customer data access.
5. **Install.** Copy the install link from the Dev Dashboard and send it to
   the brand. On install the store becomes `connected` and the full product
   sync starts on its own.

## Order API

`POST /api/orders` with `Authorization: Bearer <MAIN_BACKEND_API_KEY>`:

```json
{
  "shop": "brandx.myshopify.com",
  "aezaOrderId": "AEZA-10042",
  "isTest": true,
  "lineItems": [
    { "variantId": "gid://shopify/ProductVariant/123", "quantity": 1, "price": "1499.00" }
  ],
  "customer": { "name": "Asha Rao", "email": "asha@example.com", "phone": "+919812345678" },
  "shippingAddress": {
    "address1": "12 MG Road", "address2": "Flat 4B", "city": "Bengaluru",
    "provinceCode": "KA", "zip": "560001", "countryCode": "IN"
  },
  "paymentReference": "cf_pay_abc123"
}
```

Creates a **paid** order (one successful SALE transaction via gateway
"Aeza (Cashfree)" for the line total), tagged `Aeza` (+ `Aeza Test` for test
orders), note and `sourceIdentifier` carry the Aeza order id, stock is
decremented (`DECREMENT_OBEYING_POLICY`), no emails are sent to the customer.

| Status | Body |
|---|---|
| 201 | `{ shopifyOrderId, shopifyOrderName }` |
| 200 | same, plus `duplicate: true` (this `aezaOrderId` was already created) |
| 400 | `invalid_request` / `invalid_json` |
| 401 | `unauthorized` |
| 404 | `unknown_shop` |
| 409 | `store_not_connected`, `order_in_progress` (same id in flight; retry in a few seconds) |
| 422 | `unknown_variant`, `product_not_available`, `out_of_stock`, `shopify_rejected` (+ `details`) |
| 502 | `shopify_unavailable`: outcome unknown. The id stays locked for 2 minutes; check Shopify (tag `Aeza`, note has the id) before retrying. |

## Test checklist (dev store first)

Setup: a Neon branch DB with migrations applied, the app running
(`npm run dev` or a preview deploy), and the dev store registered with
`store:add` + `shopify app deploy --config <slug>`.

- [ ] Install via the custom link → `ShopifyStore.status = connected`;
      `Session.accessToken` starts with `enc:v1:`; within a minute
      `ShopifyProduct` / `ShopifyVariant` hold every product with sizes,
      prices, stock and images, and `lastFullSyncAt` is set.
- [ ] Change a price in Shopify → `ShopifyVariant.price` updates within a minute.
- [ ] Set a variant's stock to 0 → `availableQty = 0`.
- [ ] "Only selected": a new product appears unpublished; publishing it in
      the dashboard sets `published = true`.
- [ ] "Show all products on Aeza": every active product is published; a new
      product is published automatically; a draft is not.
- [ ] `POST /api/orders` with `isTest: true` → order in Shopify, paid,
      tagged "Aeza Test", stock reduced. Send the same `aezaOrderId` again →
      200 with `duplicate: true`, no second order.
- [ ] Fulfil the order in Shopify with tracking → `ShopifyOrder` has
      tracking company/number/url.
- [ ] Cancel it in Shopify → `ShopifyOrder.cancelledAt` is set.
- [ ] Uninstall → store `uninstalled`, all its products `published = false`,
      sessions deleted. Reinstall → `connected` again and a fresh sync runs.
- [ ] Redeliver a webhook (Dev Dashboard → webhook deliveries) → one
      `WebhookEvent` row, processed once.
- [ ] `curl -H "Authorization: Bearer $CRON_SECRET" <app>/api/cron/resync`
      → `{ "started": 1, ... }`.

## Scripts

| Command | What |
|---|---|
| `npm run store:add -- ...` | Register a brand store + generate its toml (see above). |
| `npm run sessions:encrypt` | One-off: encrypt tokens in old plain-text `Session` rows. |
| `npm run typecheck` / `lint` / `build` | Checks. |

Scripts run on Node's built-in TypeScript support (Node >= 22.18).
