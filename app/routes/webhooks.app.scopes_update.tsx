import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { handleWebhook } from "../services/webhooks.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  return handleWebhook(request, async ({ payload, session }) => {
    const current = payload.current as string[];
    if (session) {
      await db.session.update({
        where: { id: session.id },
        data: { scope: current.toString() },
      });
    }
  });
};
