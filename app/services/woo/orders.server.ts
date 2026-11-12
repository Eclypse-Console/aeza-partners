import { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import type { OrderRequest } from "../orders.server";
import {
  buildWooOrder,
  findAezaOrder,
  liveStock,
  parseHandle,
  parseWooVariantGid,
  productIsLive,
  resolveLine,
  wooOrderGid,
  wooOrderStatus,
} from "./checkout";
import type { WooOrder, WooOrderLine, WooResolved } from "./checkout";
import { wooCredentials } from "./client.server";
import type { WooProduct, WooVariation } from "./map";

// The HTTP + database side of Woo checkout (rules in checkout.ts). Reached only
// through the existing connector endpoints, for shops in WOO_SHOPS; responses use
// the same statuses and error codes as the Shopify path, so the backend's
// retry/refund handling is unchanged:
//   422 = Woo will never accept it (refund), 409 = in progress, 502 = try again.

const TIMEOUT_MS = 20_000;
// Same as the Shopify path: a claim older than this, with no order id, is a request
// that died; the next attempt takes it over after checking Woo for the order.
const CLAIM_TTL_MS = 2 * 60 * 1000;

type WooResult<T> = { status: number; data: T | null };

async function wooApi<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<WooResult<T>> {
  const credentials = wooCredentials();
  const response = await fetch(`${credentials.site}/wp-json/wc/v3${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${credentials.key}:${credentials.secret}`).toString("base64")}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await response.json().catch(() => null)) as T | null;
  return { status: response.status, data };
}

async function wooGet<T>(path: string): Promise<T | null> {
  const { status, data } = await wooApi<T>("GET", path);
  if (status === 404) return null;
  if (status !== 200) throw new Error(`Woo GET ${path.split("?")[0]} failed: HTTP ${status}`);
  return data;
}

// ------------------------------------------------------------------ resolve

/** Live price/stock for cart lines, in the exact shape of resolveCartItems(). */
export async function resolveWooCart(items: Array<{ handle: string; size: string | null }>) {
  const bySlug = new Map<string, { product: WooProduct | null; variations: WooVariation[] }>();
  for (const { handle } of items) {
    const { slug } = parseHandle(handle);
    if (bySlug.has(slug)) continue;
    const found = await wooGet<WooProduct[]>(`/products?slug=${encodeURIComponent(slug)}&per_page=1`);
    const product = found?.[0] ?? null;
    const variations =
      product?.type === "variable" ? ((await wooGet<WooVariation[]>(`/products/${product.id}/variations?per_page=100`)) ?? []) : [];
    bySlug.set(slug, { product, variations });
  }

  const resolved: WooResolved[] = [];
  const sizes: Record<string, Array<{ size: string; stock: number | null }>> = {};
  for (const { handle, size } of items) {
    const { product, variations } = bySlug.get(parseHandle(handle).slug)!;
    const line = resolveLine(handle, size, product, variations);
    resolved.push(line.item);
    if (line.sizes.length) sizes[handle] = line.sizes;
  }
  return { items: resolved, sizes };
}

// ------------------------------------------------------------------ orders

type OrderResult = { status: number; body: Record<string, unknown> };
const fail = (status: number, error: string, extra = {}): OrderResult => ({ status, body: { error, ...extra } });

/** Re-reads every line live and checks it can still be sold at that quantity. */
async function checkLines(lineItems: OrderRequest["lineItems"]): Promise<{ lines: WooOrderLine[] } | OrderResult> {
  const lines: WooOrderLine[] = [];
  const unknown: string[] = [];
  const unavailable: string[] = [];
  const outOfStock: string[] = [];
  for (const item of lineItems) {
    const ref = parseWooVariantGid(item.variantId);
    const node = ref ? await wooGet<WooProduct & { parent_id?: number; type: string }>(`/products/${ref.id}`) : null;
    if (!ref || !node || (ref.kind === "variation" ? node.type !== "variation" : node.type === "variation")) {
      unknown.push(item.variantId);
      continue;
    }
    const parent = ref.kind === "variation" ? await wooGet<WooProduct>(`/products/${node.parent_id}`) : node;
    if (!parent || !productIsLive(parent) || node.status !== "publish") {
      unavailable.push(item.variantId);
      continue;
    }
    const stock = liveStock(node as unknown as WooVariation, parent);
    if (stock !== null && stock < item.quantity) {
      outOfStock.push(item.variantId);
      continue;
    }
    lines.push({
      productId: parent.id,
      variationId: ref.kind === "variation" ? ref.id : null,
      quantity: item.quantity,
      price: item.price,
    });
  }
  if (unknown.length) return fail(422, "unknown_variant", { variantIds: unknown });
  if (unavailable.length) return fail(422, "product_not_available", { variantIds: unavailable });
  if (outOfStock.length) return fail(422, "out_of_stock", { variantIds: outOfStock });
  return { lines };
}

/** Claims the Aeza order id for this shop so two requests can't both create it. */
async function claimOrder(shop: string, aezaOrderId: string): Promise<{ id: number; tookOver: Date | null } | null> {
  const existing = await prisma.shopifyOrder.findUnique({ where: { shop_aezaOrderId: { shop, aezaOrderId } } });
  if (!existing) {
    try {
      const row = await prisma.shopifyOrder.create({ data: { shop, aezaOrderId, isTest: false }, select: { id: true } });
      return { id: row.id, tookOver: null };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null;
      throw error;
    }
  }
  if (existing.shopifyOrderId || Date.now() - existing.updatedAt.getTime() < CLAIM_TTL_MS) return null;
  const taken = await prisma.shopifyOrder.updateMany({
    where: { id: existing.id, updatedAt: existing.updatedAt, shopifyOrderId: null },
    data: { isTest: false },
  });
  return taken.count === 1 ? { id: existing.id, tookOver: existing.createdAt } : null;
}

async function recordOrder(claimId: number, order: WooOrder) {
  await prisma.shopifyOrder.update({
    where: { id: claimId },
    data: { shopifyOrderId: wooOrderGid(order.id), shopifyOrderName: `#${order.number}`, financialStatus: "paid" },
  });
}

/** Create the paid order on the Woo store. Same contract and idempotency as createAezaOrder(). */
export async function createWooOrder(input: OrderRequest): Promise<OrderResult> {
  const { shop, aezaOrderId } = input;
  // A sandbox payment must never become a real order on the brand's live store.
  if (input.isTest) return fail(422, "test_orders_not_supported");

  const existing = await prisma.shopifyOrder.findUnique({ where: { shop_aezaOrderId: { shop, aezaOrderId } } });
  if (existing?.shopifyOrderId) {
    return {
      status: 200,
      body: { shopifyOrderId: existing.shopifyOrderId, shopifyOrderName: existing.shopifyOrderName, duplicate: true },
    };
  }

  let checked;
  try {
    checked = await checkLines(input.lineItems);
  } catch (error) {
    console.error(`Woo order ${aezaOrderId}: line check failed:`, error);
    return fail(502, "shopify_unavailable");
  }
  if ("status" in checked) return checked;

  const claim = await claimOrder(shop, aezaOrderId);
  if (!claim) return fail(409, "order_in_progress");

  try {
    if (claim.tookOver) {
      // A previous attempt died after claiming: Woo may already have the order.
      const after = new Date(claim.tookOver.getTime() - 10 * 60 * 1000).toISOString().slice(0, 19);
      const recent = (await wooGet<WooOrder[]>(`/orders?after=${after}&per_page=100&orderby=date&order=desc`)) ?? [];
      const found = findAezaOrder(recent, aezaOrderId);
      if (found) {
        await recordOrder(claim.id, found);
        return { status: 200, body: { shopifyOrderId: wooOrderGid(found.id), shopifyOrderName: `#${found.number}`, duplicate: true } };
      }
    }

    const payload = buildWooOrder({
      aezaOrderId,
      paymentReference: input.paymentReference,
      lines: checked.lines,
      shippingPrice: input.shippingPrice ?? "0",
      customer: input.customer,
      shippingAddress: input.shippingAddress,
    });
    const { status, data } = await wooApi<WooOrder & { message?: string; code?: string }>("POST", "/orders", payload);
    if (status === 201 && data?.id) {
      await recordOrder(claim.id, data);
      return { status: 201, body: { shopifyOrderId: wooOrderGid(data.id), shopifyOrderName: `#${data.number}`, created: true } };
    }
    if (status >= 400 && status < 500) {
      // Woo refused it, so no order exists: release the claim (a corrected retry can go through).
      await prisma.shopifyOrder.delete({ where: { id: claim.id } });
      return fail(422, "shopify_rejected", { details: { code: data?.code ?? null, message: data?.message ?? null } });
    }
    // 5xx: the outcome is unknown, so the claim stays; a retry after CLAIM_TTL_MS checks Woo first.
    console.error(`Woo order ${aezaOrderId} for ${shop}: HTTP ${status}`);
    return fail(502, "shopify_unavailable");
  } catch (error) {
    console.error(`Woo order ${aezaOrderId} for ${shop} failed:`, error);
    return fail(502, "shopify_unavailable");
  }
}

// ------------------------------------------------------------------ status

/** Current status of the Woo order, in the shape of /api/order-fulfillments. null = not found. */
export async function wooFulfillments(shop: string, aezaOrderId: string) {
  const row = await prisma.shopifyOrder.findUnique({
    where: { shop_aezaOrderId: { shop, aezaOrderId } },
    select: { shopifyOrderId: true },
  });
  const id = row?.shopifyOrderId ? /^gid:\/\/woocommerce\/Order\/(\d+)$/.exec(row.shopifyOrderId)?.[1] : null;
  if (!id) return null;
  const order = await wooGet<WooOrder>(`/orders/${id}`);
  return order ? wooOrderStatus(order) : null;
}
