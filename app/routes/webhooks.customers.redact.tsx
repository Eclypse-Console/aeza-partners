import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// This app does not store any customer PII, so there is no data to redact.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  return new Response();
};
