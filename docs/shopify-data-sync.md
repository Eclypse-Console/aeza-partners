# How Aeza gets product, stock and order data from a brand's Shopify store

Reference for the team: which Shopify endpoints, webhooks and permissions the
Aeza Partner app uses, what the responses look like, how each field lands in
our database, and how to reproduce every call in Postman.

Examples use **Sands of India** (`cb0c82-9b.myshopify.com`). The sample JSON
below is real output from their store, shortened.

---

## 1. Access: how we're allowed to read a brand's data

| | |
|---|---|
| API | Shopify **Admin GraphQL API**, version **2026-07**. We use no REST endpoints. |
| Endpoint | One URL for every call: `POST https://{shop}/admin/api/2026-07/graphql.json` |
| Auth header | `X-Shopify-Access-Token: <token>` |
| Token | One **offline access token per store**, issued when the brand installs their private Aeza app. Expires every **1 hour** and is renewed automatically with a refresh token (valid ~90 days, renewed on every use). Both are stored **encrypted** in `shopify_connector."Session"`. |
| Permissions (scopes) | `read_products`, `read_inventory`, `read_locations`, `read_orders`, `write_orders`, `read_fulfillments` |

Each brand has its own app (own client id/secret, stored encrypted in
`ShopifyStore`), so a token only ever works for that one brand's store.

### Getting a token for Postman

From `aeza-test-connector/`:

```
npm run store:token -- --shop cb0c82-9b.myshopify.com
```

It prints a currently valid token in your terminal (refreshing and saving it
first if it's about to expire). **Treat it like a password**: it can read that
brand's products and orders until it expires about an hour later. Never paste
it into chat, tickets or code.

---

## 2. Postman setup

1. Postman → **Import** → `docs/postman/aeza-shopify-admin.postman_collection.json`.
2. Open the collection → **Variables**: set `shop` (e.g. `cb0c82-9b.myshopify.com`)
   and paste the token into `access_token`. The collection already sends it
   as the `X-Shopify-Access-Token` header on every request.
3. Run the requests:

| Request | What you see |
|---|---|
| **1. One product with all variants** | The exact query the app runs when a product changes. Set `product_id` to any product GID. |
| **2. Browse products** | 10 products per page with the same fields as the full sync. Copy `pageInfo.endCursor` into `after` for the next page. |
| **3. Start full catalog export** | Starts the same bulk export the app runs on install and nightly. Only reads; the live app will re-import afterwards (harmless). |
| **4. Latest export status** | When `status` is `COMPLETED`, open `url` in a browser to download the whole catalog as JSONL. |
| **5. Stock for one inventory item** | What we re-read when stock changes. |
| **6. Shop currency** | Used before creating an order. |

When the token expires (HTTP 401), run `npm run store:token` again and update
`access_token`.

---

## 3. Full catalog sync (on install + nightly)

Big catalogs can't be paged through within one web request, so we ask
Shopify to export everything in the background (a **Bulk Operation**).

**Step 1: start the export** (`app/services/product-sync.server.ts`, `startFullProductSync`)

```graphql
mutation StartProductBulkSync($query: String!) {
  bulkOperationRunQuery(query: $query) {
    bulkOperation { id status }
    userErrors { field message }
  }
}
```

with this as `$query`:

```graphql
{
  products {
    edges {
      node {
        id title handle descriptionHtml vendor productType tags status updatedAt
        media { edges { node { ... on MediaImage { image { url } } } } }
        variants {
          edges {
            node {
              id sku title price compareAtPrice inventoryQuantity
              selectedOptions { name value }
              inventoryItem { id }
            }
          }
        }
      }
    }
  }
}
```

**Step 2: Shopify notifies us.** When it's done (Sands of India: 224
products in 4 seconds), Shopify calls our `bulk_operations/finish` webhook.

**Step 3: fetch the result URL**

```graphql
query BulkOperationResult($id: ID!) {
  node(id: $id) { ... on BulkOperation { status errorCode url createdAt } }
}
```

**Step 4: download and import the file.** `url` is a temporary download
link to a **JSONL** file: one JSON object per line. Each product is one line,
followed by one line per image and per variant, linked by `__parentId`.
Real lines from Sands of India:

```json
{"id":"gid://shopify/Product/9448278884632","title":"Sands Of India Women’s White Yoke Embroidered Poplin Midi Dress - 1568","handle":"detailed-embroidered-yoke-and-tassels-dress","descriptionHtml":"<div class=\"container\">…","vendor":"Sands of India","productType":"Dress","tags":["SOIVODRS04/1569/1568"],"status":"ACTIVE","updatedAt":"2026-10-21T08:45:56Z"}
{"image":{"url":"https://cdn.shopify.com/s/files/1/0880/0554/2168/files/1568.png?v=1784615566"},"__parentId":"gid://shopify/Product/9448278884632"}
{"image":{"url":"https://cdn.shopify.com/s/files/1/0880/0554/2168/files/SI-1811202401_1.jpg?v=1733288391"},"__parentId":"gid://shopify/Product/9448278884632"}
{"id":"gid://shopify/ProductVariant/…","sku":"SIDR0030324XS","title":"XS","price":"1908.00","compareAtPrice":"4299.00","inventoryQuantity":10,"selectedOptions":[{"name":"Size","value":"XS"}],"inventoryItem":{"id":"gid://shopify/InventoryItem/…"},"__parentId":"gid://shopify/Product/9448278884632"}
```

We save products in batches of 100, then mark anything we have that wasn't
in the export as deleted, and set `ShopifyStore.lastFullSyncAt`.

---

## 4. Single-product refresh (product webhooks)

When a product is created or edited, we re-read it from Shopify (we don't
trust the webhook body), including every variant:

```graphql
query RefreshProduct($id: ID!, $variantsAfter: String) {
  product(id: $id) {
    id title handle descriptionHtml vendor productType tags status updatedAt
    media(first: 50) { nodes { ... on MediaImage { image { url } } } }
    variants(first: 250, after: $variantsAfter) {
      nodes {
        id sku title price compareAtPrice inventoryQuantity
        selectedOptions { name value }
        inventoryItem { id }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}
```

Real response (Sands of India, shortened to 2 images / 2 variants):

```json
{
  "data": {
    "product": {
      "id": "gid://shopify/Product/10025366651160",
      "title": "Sands Of India Black Poplin Embroidered Co-ord Set for Women - 3104",
      "handle": "soivocs76-black-poplin-embroidered-co-ord-set-for-women",
      "descriptionHtml": "<p data-path-to-node=\"2\"><b …>Effortl…",
      "vendor": "Sands of India",
      "productType": "Co-ord set",
      "tags": ["3039"],
      "status": "ACTIVE",
      "updatedAt": "2026-10-22T07:49:36Z",
      "media": {
        "nodes": [
          { "image": { "url": "https://cdn.shopify.com/s/files/1/0880/0554/2168/files/3104.png?v=1782987847" } },
          { "image": { "url": "https://cdn.shopify.com/s/files/1/0880/0554/2168/files/SOIVOCT77B_2_dfa3cef4-eac2-4bab-957e-46feacc98fba.jpg?v=1767677901" } }
        ]
      },
      "variants": {
        "nodes": [
          {
            "id": "gid://shopify/ProductVariant/51615929434392",
            "sku": "SICO0410326XS",
            "title": "XS",
            "price": "2353.00",
            "compareAtPrice": "4999.00",
            "inventoryQuantity": 13,
            "selectedOptions": [{ "name": "Size", "value": "XS" }],
            "inventoryItem": { "id": "gid://shopify/InventoryItem/53675457118488" }
          },
          {
            "id": "gid://shopify/ProductVariant/51615929467160",
            "sku": "SICO04103260S",
            "title": "S",
            "price": "2353.00",
            "compareAtPrice": "4999.00",
            "inventoryQuantity": 23,
            "selectedOptions": [{ "name": "Size", "value": "S" }],
            "inventoryItem": { "id": "gid://shopify/InventoryItem/53675457151256" }
          }
        ],
        "pageInfo": { "hasNextPage": true, "endCursor": "eyJsYXN0X2lkIjo1MTYxNTkyOTQ2NzE2MCwibGFzdF92YWx1ZSI6Mn0=" }
      }
    }
  }
}
```

---

## 5. Webhooks: Shopify tells us when something changes

All subscriptions are declared per brand app in `shopify.app.<slug>.toml`
(generated from `shopify.app.template.toml`) and pushed with
`shopify app deploy --config <slug>`.

Every delivery is verified with that brand app's secret (HMAC), recorded in
`WebhookEvent` by its `X-Shopify-Webhook-Id` (a repeat delivery is ignored),
answered with `200` immediately, then processed in the background.

| Topic | Sent to | What we do |
|---|---|---|
| `products/create`, `products/update` | `/webhooks/events` | Re-fetch the product (section 4) and upsert product + variants |
| `products/delete` | `/webhooks/events` | Mark deleted, unpublish |
| `inventory_levels/update` | `/webhooks/events` | Re-read that inventory item's stock, update `availableQty` |
| `orders/updated`, `orders/cancelled` | `/webhooks/events` | Update financial/fulfillment status and `cancelledAt` on **Aeza** orders only |
| `fulfillments/create`, `fulfillments/update` | `/webhooks/events` | Save tracking company / number / URL and shipment status |
| `bulk_operations/finish` | `/webhooks/events` | Import the full catalog export (section 3) |
| `app/uninstalled` | `/webhooks/app/uninstalled` | Store → `uninstalled`, all products unpublished, sessions deleted |
| `app/scopes_update` | `/webhooks/app/scopes_update` | Update granted scopes |
| `customers/data_request`, `customers/redact`, `shop/redact` | `/webhooks/compliance` | GDPR; `shop/redact` deletes the shop's data |

Webhook bodies use Shopify's REST-style JSON (snake_case). The only fields we
read from them:

| Topic | Fields used |
|---|---|
| products/create, products/update | `admin_graphql_api_id` |
| products/delete | `id` |
| inventory_levels/update | `inventory_item_id` |
| orders/updated, orders/cancelled | `admin_graphql_api_id`, `financial_status`, `fulfillment_status`, `cancelled_at` |
| fulfillments/create, fulfillments/update | `order_id`, `tracking_company`, `tracking_number`, `tracking_url`, `shipment_status` |
| bulk_operations/finish | `admin_graphql_api_id`, `type` |

Full payload examples per topic: https://shopify.dev/docs/api/webhooks/2026-07
You can also see real deliveries for a brand in the Dev Dashboard → the
brand's app → **Logs**.

---

## 6. Where each field lands in our database (`shopify_connector` schema)

### `ShopifyProduct` (one row per product)

| Column | Comes from | Example (Sands of India) |
|---|---|---|
| `shop` | the store | `cb0c82-9b.myshopify.com` |
| `productId` | `product.id` | `gid://shopify/Product/10025366651160` |
| `title` | `title` | `Sands Of India Black Poplin Embroidered Co-ord Set for Women - 3104` |
| `handle` | `handle` | `soivocs76-black-poplin-embroidered-co-ord-set-for-women` |
| `descriptionHtml` | `descriptionHtml` | HTML |
| `vendor` | `vendor` | `Sands of India` |
| `productType` | `productType` | `Co-ord set` |
| `tags` | `tags` | `["3039"]` |
| `images` | every `media[].image.url` | JSON array of URLs |
| `status` | `status` | `ACTIVE` / `DRAFT` / `ARCHIVED` |
| `shopifyUpdatedAt` | `updatedAt` | `2026-10-22T07:49:36Z` |
| `published` | **ours**: brand's choice in the Aeza dashboard (or "show all" mode) | `true` |
| `syncedAt`, `syncStatus`, `syncError`, `deletedAt`, `createdAt`, `updatedAt` | **ours** | |

### `ShopifyVariant` (one row per size/colour)

| Column | Comes from | Example |
|---|---|---|
| `variantId` | `variant.id` | `gid://shopify/ProductVariant/51615929434392` |
| `shop`, `productId` | parent product | |
| `sku` | `sku` | `SICO0410326XS` |
| `title` | `title` | `XS` |
| `options` | `selectedOptions` as an object | `{"Size": "XS"}` |
| `price` | `price` (selling price) | `2353.00` |
| `compareAtPrice` | `compareAtPrice` (MRP) | `4999.00` |
| `inventoryItemId` | `inventoryItem.id` | `gid://shopify/InventoryItem/53675457118488` |
| `availableQty` | `inventoryQuantity` (total available across locations) | `13` |

### `ShopifyOrder` (only orders Aeza created)

Filled by `POST /api/orders` and kept up to date by the order and
fulfillment webhooks: `aezaOrderId`, `shopifyOrderId`, `shopifyOrderName`,
`financialStatus`, `fulfillmentStatus`, `cancelledAt`, `trackingCompany`,
`trackingNumber`, `trackingUrl`, `shipmentStatus`, `isTest`.

---

## 7. Want more columns? Fields Shopify has that we don't fetch yet

Try any of these in Postman request 1 or 2 first. Useful candidates:

| Level | Field | Gives you |
|---|---|---|
| Product | `options { name values }` | All option names/values (e.g. Size: XS…XL) |
| Product | `category { name fullName }` | Shopify's standard taxonomy category |
| Product | `createdAt`, `publishedAt` | Dates |
| Product | `totalInventory` | Stock across all variants |
| Product | `onlineStoreUrl` | Product page on the brand's website |
| Product | `seo { title description }` | SEO title/description |
| Product | `featuredMedia { ... on MediaImage { image { url altText } } }` | Main image |
| Product | `metafields(first: 20) { nodes { namespace key value type } }` | Brand-specific custom data (fabric, fit, care…) if they use it |
| Media | `image { altText width height }` | Image alt text and size |
| Variant | `barcode` | EAN/UPC |
| Variant | `media(first: 5) { nodes { ... on MediaImage { image { url } } } }` | Variant-specific images (e.g. per colour) |
| Variant | `inventoryPolicy` | Whether the brand allows selling when out of stock |
| Variant | `inventoryItem { measurement { weight { value unit } } }` | Shipping weight |
| Variant | `position` | Size order |

To add one: add the field to **both** queries in
`app/services/product-sync.server.ts` (`BULK_PRODUCTS_QUERY` and
`RefreshProduct`), add the column in `prisma/schema.prisma` with a new
migration, and map it in `toSyncedProduct` / `toSyncedVariant` and
`saveProducts`. The next nightly or manual full sync fills it for every
product. Some fields (e.g. metafields from other apps) may need extra scopes.
