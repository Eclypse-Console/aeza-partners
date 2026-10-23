import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { handleWebhook } from "../services/webhooks.server";

// Shopify's three mandatory GDPR/compliance topics all deliver to this one
// endpoint (see compliance_topics in the app toml). This app does not store
// customer PII (orders are kept without customer details), so only
// shop/redact has data to act on. ShopifyStore (the app's credentials) is
// kept so the brand can reinstall; variants cascade with their products.
export const action = async ({ request }: ActionFunctionArgs) => {
  return handleWebhook(request, async ({ shop, topic }) => {
    if (topic !== "SHOP_REDACT") return;

    await db.session.deleteMany({ where: { shop } });
    await db.brandProfile.deleteMany({ where: { shop } });
    await db.shopifyProduct.deleteMany({ where: { shop } });
    await db.shopifyOrder.deleteMany({ where: { shop } });
    await db.webhookEvent.deleteMany({ where: { shop } });
  });
};
