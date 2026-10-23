import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { runAdminQuery } from "../models/products.server";
import { unauthenticated } from "../shopify.server";
import { isLiveOnAeza } from "./aeza-catalog.server";

// Creates a paid order on a brand's Shopify store for an order the customer
// already paid for on Aeza. Idempotent per (shop, aezaOrderId):
//   - already created  -> the existing Shopify order is returned, nothing new,
//   - another request for the same id is in flight -> 409, retry later,
//   - Shopify rejected it (e.g. out of stock) -> the claim is released so a
//     corrected retry can go through.
// Every Shopify order is also tagged with its Aeza order id, and that tag is
// looked up before creating. So if a request died after Shopify accepted the
// order but before we saved its id, the retry (once the claim expires after
// CLAIM_TTL_MS) finds and adopts that order instead of creating a second one.

const CLAIM_TTL_MS = 2 * 60 * 1000;
const GATEWAY = "Aeza (Cashfree)";

export type OrderRequest = {
  shop: string;
  aezaOrderId: string;
  isTest: boolean;
  lineItems: Array<{ variantId: string; quantity: number; price: string }>;
  /** Shipping charged to the customer, e.g. "49.00". Omit or "0" for free shipping. */
  shippingPrice?: string;
  customer: { name: string; email: string; phone: string };
  shippingAddress: {
    firstName?: string;
    lastName?: string;
    address1: string;
    address2?: string;
    city: string;
    provinceCode?: string;
    zip: string;
    countryCode: string;
    phone?: string;
  };
  paymentReference: string;
};

export type OrderResult = {
  status: number;
  body: Record<string, unknown>;
};

const fail = (status: number, error: string, extra = {}): OrderResult => ({
  status,
  body: { error, ...extra },
});

export async function createAezaOrder(input: OrderRequest): Promise<OrderResult> {
  const { shop, aezaOrderId } = input;

  const store = await prisma.shopifyStore.findUnique({ where: { shop } });
  if (!store) return fail(404, "unknown_shop");
  if (store.status !== "connected") return fail(409, "store_not_connected");

  const existing = await prisma.shopifyOrder.findUnique({
    where: { shop_aezaOrderId: { shop, aezaOrderId } },
  });
  if (existing?.shopifyOrderId) {
    return {
      status: 200,
      body: {
        shopifyOrderId: existing.shopifyOrderId,
        shopifyOrderName: existing.shopifyOrderName,
        duplicate: true,
      },
    };
  }

  // Check every line against our product copy before claiming anything.
  const variantIds = input.lineItems.map((item) => item.variantId);
  const variants = await prisma.shopifyVariant.findMany({
    where: { shop, variantId: { in: variantIds } },
    include: { product: true },
  });
  const byId = new Map(variants.map((variant) => [variant.variantId, variant]));
  const unknown = variantIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    return fail(422, "unknown_variant", { variantIds: unknown });
  }
  const unavailable = variants
    .filter((variant) => !isLiveOnAeza(variant.product))
    .map((variant) => variant.variantId);
  if (unavailable.length > 0) {
    return fail(422, "product_not_available", { variantIds: unavailable });
  }

  // Claim the aezaOrderId so concurrent requests can't both create it.
  const claim = await claimOrder(existing, input);
  if (!claim) return fail(409, "order_in_progress");

  try {
    const { admin } = await unauthenticated.admin(shop);
    const { shop: shopInfo } = await runAdminQuery<{
      shop: { currencyCode: string };
    }>(admin, `#graphql query ShopCurrency { shop { currencyCode } }`, {});
    const currencyCode = shopInfo.currencyCode;

    const recovered = await findShopifyOrderByTag(admin, aezaOrderId);
    if (recovered) {
      await prisma.shopifyOrder.update({
        where: { id: claim.id },
        data: {
          shopifyOrderId: recovered.id,
          shopifyOrderName: recovered.name,
          financialStatus: "paid",
        },
      });
      return {
        status: 200,
        body: {
          shopifyOrderId: recovered.id,
          shopifyOrderName: recovered.name,
          duplicate: true,
        },
      };
    }

    const shippingPaise = toMinorUnits(input.shippingPrice ?? "0");
    const totalPaise =
      input.lineItems.reduce(
        (sum, item) => sum + toMinorUnits(item.price) * item.quantity,
        0,
      ) + shippingPaise;
    const money = (minor: number) => ({
      shopMoney: { amount: (minor / 100).toFixed(2), currencyCode },
    });

    const [firstName, ...rest] = input.customer.name.trim().split(/\s+/);
    const address = input.shippingAddress;

    const data = await runAdminQuery<{
      orderCreate: {
        order: { id: string; name: string } | null;
        userErrors: Array<{ field: string[] | null; message: string; code: string | null }>;
      };
    }>(
      admin,
      `#graphql
      mutation CreateAezaOrder($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
        orderCreate(order: $order, options: $options) {
          order { id name }
          userErrors { field message code }
        }
      }`,
      {
        order: {
          currency: currencyCode,
          email: input.customer.email,
          phone: input.customer.phone,
          test: input.isTest,
          financialStatus: "PAID",
          tags: input.isTest
            ? ["Aeza", "Aeza Test", aezaOrderId]
            : ["Aeza", aezaOrderId],
          note: `Aeza order ${aezaOrderId} (payment ${input.paymentReference})`,
          sourceName: "Aeza",
          sourceIdentifier: aezaOrderId,
          customAttributes: [{ key: "aeza_order_id", value: aezaOrderId }],
          lineItems: input.lineItems.map((item) => ({
            variantId: item.variantId,
            quantity: item.quantity,
            priceSet: money(toMinorUnits(item.price)),
          })),
          ...(shippingPaise > 0
            ? {
                shippingLines: [
                  { title: "Aeza shipping", priceSet: money(shippingPaise) },
                ],
              }
            : {}),
          shippingAddress: {
            firstName: address.firstName ?? firstName,
            lastName: address.lastName ?? (rest.join(" ") || firstName),
            address1: address.address1,
            address2: address.address2,
            city: address.city,
            provinceCode: address.provinceCode,
            zip: address.zip,
            countryCode: address.countryCode,
            phone: address.phone ?? input.customer.phone,
          },
          transactions: [
            {
              kind: "SALE",
              status: "SUCCESS",
              gateway: GATEWAY,
              authorizationCode: input.paymentReference,
              amountSet: money(totalPaise),
            },
          ],
        },
        options: {
          inventoryBehaviour: "DECREMENT_OBEYING_POLICY",
          sendReceipt: false,
          sendFulfillmentReceipt: false,
        },
      },
    );

    const { order, userErrors } = data.orderCreate;
    if (userErrors.length > 0 || !order) {
      // Shopify rejected it, so no order exists: release the claim.
      await prisma.shopifyOrder.delete({ where: { id: claim.id } });
      const outOfStock = userErrors.some((error) =>
        /inventory|stock|quantity/i.test(`${error.code ?? ""} ${error.message}`),
      );
      return fail(422, outOfStock ? "out_of_stock" : "shopify_rejected", {
        details: userErrors,
      });
    }

    await prisma.shopifyOrder.update({
      where: { id: claim.id },
      data: {
        shopifyOrderId: order.id,
        shopifyOrderName: order.name,
        financialStatus: "paid",
      },
    });
    return {
      status: 201,
      body: { shopifyOrderId: order.id, shopifyOrderName: order.name, created: true },
    };
  } catch (error) {
    // Outcome unknown (network, timeout): keep the claim so a quick retry
    // can't create a second order; it expires after CLAIM_TTL_MS.
    console.error(`Order ${aezaOrderId} for ${shop} failed:`, error);
    return fail(502, "shopify_unavailable");
  }
}

/** The Shopify order already tagged with this Aeza order id, if any. */
async function findShopifyOrderByTag(
  admin: Parameters<typeof runAdminQuery>[0],
  aezaOrderId: string,
): Promise<{ id: string; name: string } | null> {
  const data = await runAdminQuery<{
    orders: { nodes: Array<{ id: string; name: string }> };
  }>(
    admin,
    `#graphql
    query FindAezaOrder($q: String!) {
      orders(first: 1, query: $q) { nodes { id name } }
    }`,
    // aezaOrderId is validated (no quotes, commas or backslashes), so it is safe to quote.
    { q: `tag:"${aezaOrderId}"` },
  );
  return data.orders.nodes[0] ?? null;
}

async function claimOrder(
  existing: { id: number; updatedAt: Date } | null,
  input: OrderRequest,
): Promise<{ id: number } | null> {
  if (!existing) {
    try {
      return await prisma.shopifyOrder.create({
        data: { shop: input.shop, aezaOrderId: input.aezaOrderId, isTest: input.isTest },
        select: { id: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return null;
      }
      throw error;
    }
  }

  if (Date.now() - existing.updatedAt.getTime() < CLAIM_TTL_MS) return null;

  // Stale claim from an attempt that never finished: take it over, but only
  // if nobody else did in the meantime (updatedAt acts as a version).
  const taken = await prisma.shopifyOrder.updateMany({
    where: { id: existing.id, updatedAt: existing.updatedAt, shopifyOrderId: null },
    data: { isTest: input.isTest },
  });
  return taken.count === 1 ? { id: existing.id } : null;
}

function toMinorUnits(price: string): number {
  return Math.round(Number(price) * 100);
}
