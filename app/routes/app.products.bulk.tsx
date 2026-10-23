import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  MAX_BULK_PRODUCTS,
  bulkSetPublishState,
  isValidCollectionGid,
} from "../models/products.server";
import { getPublishMode } from "../services/product-sync.server";

// Resource route (no UI), POST only. Publishes or unpublishes many
// products at once: the whole store, or every product in one collection.
// The shop always comes from the authenticated session; the client only
// supplies the intended state and (optionally) a collection id, which is
// format-checked and then resolved through the shop-scoped Admin API, a
// collection from another store simply returns no products.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }

  const { session, admin } = await authenticate.admin(request);

  if ((await getPublishMode(session.shop)) === "all") {
    return Response.json(
      {
        error:
          "All products are shown on Aeza automatically. Switch to \"Only selected products\" to choose.",
      },
      { status: 409 },
    );
  }

  const formData = await request.formData();
  const published = formData.get("published") === "true";
  const rawCollectionId = String(formData.get("collectionId") ?? "");
  const collectionId = rawCollectionId || null;

  if (collectionId && !isValidCollectionGid(collectionId)) {
    return Response.json({ error: "Invalid collection id." }, { status: 400 });
  }

  // Opaque Shopify pagination cursor, present only when resuming a run that
  // stopped at the safety limit. Bounded in length; Shopify validates it.
  const rawAfter = String(formData.get("after") ?? "");
  if (rawAfter.length > 500) {
    return Response.json({ error: "Invalid cursor." }, { status: 400 });
  }
  const after = rawAfter || null;

  try {
    const { affected, truncated, nextCursor } = await bulkSetPublishState({
      admin,
      shop: session.shop,
      published,
      collectionId,
      after,
    });

    return Response.json({
      affected,
      truncated,
      nextCursor,
      limit: MAX_BULK_PRODUCTS,
      published,
    });
  } catch (error) {
    console.error("Bulk publish failed:", error);
    return Response.json(
      {
        error:
          "Couldn't update all products. Some may have changed. Refresh and try again.",
      },
      { status: 502 },
    );
  }
};
