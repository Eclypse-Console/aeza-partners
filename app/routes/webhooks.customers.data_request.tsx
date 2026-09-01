import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// This app does not store any customer PII, so there is no data to return.
// The webhook must still be verified and acknowledged within 30 days.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  return new Response();
};
