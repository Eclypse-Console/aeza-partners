import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  fetchShopifyProductById,
  isValidProductGid,
  setProductPublishState,
} from "../models/products.server";

// Resource route (no UI) — POST only. Toggles whether a single product is
// published to Aeza. Deliberately trusts nothing from the client except the
// product id and the intended published state: the product's title/image
// are always re-fetched from Shopify using the authenticated admin session,
// so this endpoint can't be used to write forged product data into our DB,
// and a ProductId from another shop simply won't resolve (Admin API tokens
// are shop-scoped).
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }

  const { session, admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const productId = String(formData.get("productId") ?? "");
  const published = formData.get("published") === "true";

  if (!isValidProductGid(productId)) {
    return Response.json({ error: "Invalid product id." }, { status: 400 });
  }

  let product;
  try {
    product = await fetchShopifyProductById(admin, productId);
  } catch (error) {
    console.error("Failed to verify product before publish toggle:", error);
    return Response.json(
      { error: "Couldn't reach Shopify to verify this product. Try again." },
      { status: 502 },
    );
  }

  if (!product) {
    return Response.json(
      { error: "That product wasn't found on this store." },
      { status: 404 },
    );
  }

  try {
    const record = await setProductPublishState({
      shop: session.shop,
      productId: product.id,
      title: product.title,
      imageUrl: product.imageUrl,
      published,
    });

    return Response.json({
      product: {
        id: record.productId,
        published: record.published,
        syncStatus: record.syncStatus,
      },
    });
  } catch (error) {
    console.error("Failed to save product publish state:", error);
    return Response.json(
      { error: "Couldn't save that change. Try again." },
      { status: 500 },
    );
  }
};
