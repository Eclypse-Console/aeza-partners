import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Shopify's three mandatory GDPR/compliance topics all deliver to this one
// endpoint (see compliance_topics in shopify.app.toml). This app does not
// store any customer PII — only shop-level BrandProfile and Session rows —
// so only shop/redact has data to act on.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
      // No customer PII is stored by this app.
      break;
    case "SHOP_REDACT":
      await db.session.deleteMany({ where: { shop } });
      await db.brandProfile.deleteMany({ where: { shop } });
      await db.publishedProduct.deleteMany({ where: { shop } });
      break;
  }

  return new Response();
};
