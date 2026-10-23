import type { ActionFunctionArgs } from "react-router";
import { markStoreUninstalled } from "../services/store.server";
import { handleWebhook } from "../services/webhooks.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  return handleWebhook(request, ({ shop }) => markStoreUninstalled(shop));
};
