import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { isPublishMode, setPublishMode } from "../services/product-sync.server";

// Resource route (no UI), POST only. Switches the brand between "Show all
// products on Aeza" (all) and "Only selected products" (selected).
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }

  const { session } = await authenticate.admin(request);
  const mode = (await request.formData()).get("mode");
  if (!isPublishMode(mode)) {
    return Response.json({ error: "Invalid mode." }, { status: 400 });
  }

  try {
    await setPublishMode(session.shop, mode);
    return Response.json({ mode });
  } catch (error) {
    console.error("Failed to change publish mode:", error);
    return Response.json(
      { error: "Couldn't change the setting. Try again." },
      { status: 500 },
    );
  }
};
