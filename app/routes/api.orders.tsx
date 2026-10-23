import type { ActionFunctionArgs } from "react-router";
import { hasValidBearerToken } from "../lib/auth.server";
import { normalizeShopDomain } from "../shopify.server";
import type { OrderRequest } from "../services/orders.server";
import { createAezaOrder } from "../services/orders.server";

// POST /api/orders, called server-to-server by the main Aeza backend after a
// customer has paid. Auth: Authorization: Bearer <MAIN_BACKEND_API_KEY>.
// Responses: 201 created, 200 already created (duplicate: true), 400 bad
// body, 401, 404 unknown_shop, 409 store_not_connected / order_in_progress,
// 422 unknown_variant / product_not_available / out_of_stock /
// shopify_rejected, 502 shopify_unavailable.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  if (!hasValidBearerToken(request, process.env.MAIN_BACKEND_API_KEY)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = parseOrderRequest(body);
  if ("error" in parsed) {
    return Response.json(
      { error: "invalid_request", message: parsed.error },
      { status: 400 },
    );
  }

  const result = await createAezaOrder(parsed);
  return Response.json(result.body, { status: result.status });
};

const isText = (value: unknown, max = 500): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const optionalText = (value: unknown) =>
  value === undefined || value === null || isText(value);

function parseOrderRequest(body: unknown): OrderRequest | { error: string } {
  if (!body || typeof body !== "object") return { error: "body must be an object" };
  const input = body as Record<string, unknown>;

  const shop = normalizeShopDomain(input.shop as string);
  if (!shop) return { error: "shop must be a *.myshopify.com domain" };
  if (!isText(input.aezaOrderId, 100)) return { error: "aezaOrderId is required" };
  if (!isText(input.paymentReference, 200)) {
    return { error: "paymentReference is required" };
  }

  if (!Array.isArray(input.lineItems) || input.lineItems.length === 0) {
    return { error: "lineItems must be a non-empty array" };
  }
  const lineItems: OrderRequest["lineItems"] = [];
  for (const item of input.lineItems as Array<Record<string, unknown>>) {
    const price = String(item?.price ?? "");
    if (
      !isText(item?.variantId) ||
      !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(item.variantId) ||
      !Number.isInteger(item.quantity) ||
      (item.quantity as number) < 1 ||
      !/^\d+(\.\d{1,2})?$/.test(price)
    ) {
      return {
        error:
          "each line item needs variantId (ProductVariant GID), quantity (integer >= 1) and price (e.g. \"999.00\")",
      };
    }
    lineItems.push({
      variantId: item.variantId,
      quantity: item.quantity as number,
      price,
    });
  }

  const customer = (input.customer ?? {}) as Record<string, unknown>;
  if (!isText(customer.name) || !isText(customer.email) || !isText(customer.phone)) {
    return { error: "customer.name, customer.email and customer.phone are required" };
  }

  const address = (input.shippingAddress ?? {}) as Record<string, unknown>;
  if (
    !isText(address.address1) ||
    !isText(address.city) ||
    !isText(address.zip, 20) ||
    !(typeof address.countryCode === "string" && /^[A-Z]{2}$/.test(address.countryCode)) ||
    !["firstName", "lastName", "address2", "provinceCode", "phone"].every((key) =>
      optionalText(address[key]),
    )
  ) {
    return {
      error:
        "shippingAddress needs address1, city, zip and countryCode (e.g. \"IN\"); firstName, lastName, address2, provinceCode (e.g. \"MH\") and phone are optional",
    };
  }

  return {
    shop,
    aezaOrderId: (input.aezaOrderId as string).trim(),
    isTest: input.isTest === true,
    lineItems,
    customer: {
      name: customer.name as string,
      email: customer.email as string,
      phone: customer.phone as string,
    },
    shippingAddress: {
      firstName: (address.firstName as string) ?? undefined,
      lastName: (address.lastName as string) ?? undefined,
      address1: address.address1 as string,
      address2: (address.address2 as string) ?? undefined,
      city: address.city as string,
      provinceCode: (address.provinceCode as string) ?? undefined,
      zip: address.zip as string,
      countryCode: address.countryCode as string,
      phone: (address.phone as string) ?? undefined,
    },
    paymentReference: input.paymentReference as string,
  };
}
