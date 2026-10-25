# Onboarding a brand

About 10 minutes. Run every command from `aeza-test-connector/`, on a machine
whose `.env` has the production `DATABASE_URL` and `ENCRYPTION_KEY`. Nothing on
Vercel changes and nothing is redeployed: every brand runs on the same
deployment at https://aeza-partners.vercel.app.

## What you need from the brand

- Their website **or** their Shopify store address. Either works: the script
  finds the permanent `xxxx.myshopify.com` address itself.
- Someone with **owner/admin** access to their Shopify admin, to install the app.

## Steps

**1. Create and register the app**

```
npm run brand:onboard -- --shop <website or store address> --brand-name "<Brand>"
```

- It prints the store it found (name, website, `xxxx.myshopify.com`). Check
  that it's the right brand.
- Shopify CLI asks two things: choose the org **Aeza - public**, then
  **create a new app**. Accept the suggested name or type
  `Aeza Partner - <Brand>`.
- It saves the app's credentials (encrypted) and writes
  `shopify.app.<store>.toml`. The secret is never shown.

**2. Set custom distribution (dashboard, no CLI for this)**

Dev Dashboard (dev.shopify.com) → org **Aeza - public** → the new app →
**Distribution → Custom distribution** → enter the `xxxx.myshopify.com` address
the script printed → **copy the install link. Don't send it yet.**

This must happen before step 3: until the app has a distribution method,
Shopify refuses the order and tracking webhooks.

**3. Deploy the app's config**

```
npm run brand:deploy -- --shop <xxxx.myshopify.com>
```

- Ends with *"Deployed … with all webhooks"*. That's done.
- Or ends with *"Deployed WITHOUT order webhooks"*. The brand can still
  install and their catalog syncs. Run the same command again later, and in
  any case before their first Aeza order.

**4. Send the install link to the brand**

They open it, click **Install**, and approve. The Aeza app opens inside their
Shopify admin. There they choose **Show all products** or pick **selected
products**. The default is *selected*, so nothing goes live until they choose.

The link doesn't expire and only works on that one store.

**5. Check**

```
npm run brand:status -- --shop <xxxx.myshopify.com>
```

Ready when `status connected`, products and variants are above 0, and
`next ready`. `npm run brand:status` with no `--shop` lists every brand.

## Send the brand this checklist

- Choose which products to show on Aeza in the app.
- When you ship an Aeza order, it must be marked **Fulfilled in Shopify with
  the courier and tracking number**, whatever tool you ship with.
- If your tool can, also sync shipment status (in transit, delivered) to Shopify.
- Cancel Aeza orders in Shopify. The customer is refunded automatically.
- Aeza orders are tagged **Aeza** in your Shopify orders. Don't edit or delete them.
- Tell us your return window (days).

## Not part of onboarding

- **Product mapping** to the Aeza catalog is handled separately. Onboarding only
  fills the connector's own tables (`shopify_connector` schema).
- **Selling on Aeza** also needs the brand enabled in the backend.

## When something goes wrong

| Symptom | Fix |
|---|---|
| `couldn't find a live Shopify store` | Wrong address, or the store is closed. Ask for Shopify admin → Settings → Domains. |
| CLI didn't offer "create a new app" | You're in the wrong org: pick **Aeza - public**. |
| App created but the script stopped | Re-run step 1 with `--client-id <id>` (from the Dev Dashboard) so no second app is made. |
| `status pending` after the brand says they installed | Ask them to open **Apps → Aeza Partner - <Brand>** once in their admin. |
| `order webhooks missing` | Check step 2, then run step 3 again. |
| Brand installed but sees a blank or example.com page | Step 3 wasn't run. Run it, then ask them to reopen the app. |
