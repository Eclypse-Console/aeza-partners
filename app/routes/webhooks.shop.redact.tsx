import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Sent 48 hours after a shop uninstalls the app. Erase any shop-identifying
// data that is still retained at that point.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  await db.session.deleteMany({ where: { shop } });
  await db.brandProfile.deleteMany({ where: { shop } });

  return new Response();
};
