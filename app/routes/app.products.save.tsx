import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  MAX_SAVE_CHANGES,
  fetchShopifyProductsByIds,
  isValidProductGid,
  saveProductSelections,
} from "../models/products.server";

// Resource route (no UI), POST only. Saves the brand's pending selection
// from the dashboard in one go: a list of { productId, published } pairs.
// Deliberately trusts nothing from the client except the product ids and the
// intended states: each product's title/image is re-fetched from Shopify
// using the authenticated admin session, so this endpoint can't be used to
// write forged product data into our DB, and a product id from another shop
// simply won't resolve (Admin API tokens are shop-scoped).
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }

  const { session, admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const invalid = Response.json(
    { error: "That selection couldn't be read. Refresh and try again." },
    { status: 400 },
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(formData.get("changes") ?? ""));
  } catch {
    return invalid;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) return invalid;
  if (parsed.length > MAX_SAVE_CHANGES) {
    return Response.json(
      {
        error: `You can save up to ${MAX_SAVE_CHANGES.toLocaleString()} changes at a time. Use "Publish all" for larger catalogs.`,
      },
      { status: 400 },
    );
  }

  const desired = new Map<string, boolean>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") return invalid;
    const { productId, published } = entry as Record<string, unknown>;
    if (
      typeof productId !== "string" ||
      !isValidProductGid(productId) ||
      typeof published !== "boolean"
    ) {
      return invalid;
    }
    desired.set(productId, published);
  }

  let products;
  try {
    products = await fetchShopifyProductsByIds(admin, [...desired.keys()]);
  } catch (error) {
    console.error("Failed to verify products before saving selection:", error);
    return Response.json(
      { error: "Couldn't reach Shopify to verify your products. Try again." },
      { status: 502 },
    );
  }

  const found = new Set(products.map((product) => product.id));
  const missing = [...desired.keys()].filter((id) => !found.has(id));

  try {
    const result = await saveProductSelections({
      shop: session.shop,
      changes: products.map((product) => ({
        product,
        published: desired.get(product.id)!,
      })),
    });

    return Response.json({
      ...result,
      saved: products.map((product) => ({
        id: product.id,
        published: desired.get(product.id)!,
      })),
      missing,
    });
  } catch (error) {
    console.error("Failed to save product selection:", error);
    return Response.json(
      { error: "Couldn't save your changes. Nothing was changed, try again." },
      { status: 500 },
    );
  }
};
