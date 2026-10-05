import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  fetchShopifyProducts,
  getProductCounts,
  isValidCollectionGid,
  mergeWithPublishState,
} from "../models/products.server";

// Resource route (no UI), GET only. Returns a page of the shop's products
// (optionally limited to one collection) merged with this shop's stored
// publish decisions. Used by the dashboard for "Load more", for switching
// the collection filter, and for refreshing after a bulk action. Counts are
// returned only with the first page of a view, since that is when the
// header needs them.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const after = url.searchParams.get("after");
  const rawCollectionId = url.searchParams.get("collection") ?? "";
  const collectionId = rawCollectionId || null;

  if (collectionId && !isValidCollectionGid(collectionId)) {
    return Response.json(
      {
        products: [],
        pageInfo: { hasNextPage: false, endCursor: null },
        counts: null,
        error: "Invalid collection.",
      },
      { status: 400 },
    );
  }

  try {
    const { products, pageInfo } = await fetchShopifyProducts(admin, {
      after,
      collectionId,
    });
    const [merged, counts] = await Promise.all([
      mergeWithPublishState(session.shop, products),
      after
        ? Promise.resolve(null)
        : getProductCounts(admin, session.shop, collectionId),
    ]);

    return Response.json({ products: merged, pageInfo, counts, error: null });
  } catch (error) {
    console.error("Failed to load product page:", error);
    return Response.json(
      {
        products: [],
        pageInfo: { hasNextPage: false, endCursor: null },
        counts: null,
        error: "Couldn't load more products. Try again.",
      },
      { status: 502 },
    );
  }
};
