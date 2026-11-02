import type { WooListing, WooProduct, WooVariation } from "./map.ts";

// Read-only WooCommerce REST client: it only ever sends GET. Auth goes in the
// Authorization header, not the URL, so keys never end up in access logs.

const PAGE_SIZE = 100;
const TIMEOUT_MS = 30_000;

export type WooCredentials = { site: string; key: string; secret: string };

export function wooCredentials(): WooCredentials {
  const site = process.env.KNITDOMAIN_WOO_SITE?.replace(/\/+$/, "");
  const key = process.env.KNITDOMAIN_WOO_KEY;
  const secret = process.env.KNITDOMAIN_WOO_SECRET;
  if (!site || !key || !secret) throw new Error("KNITDOMAIN_WOO_SITE / KEY / SECRET are not set");
  return { site, key, secret };
}

async function fetchPage<T>(credentials: WooCredentials, path: string, page: number): Promise<{ items: T[]; pages: number }> {
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetch(`${credentials.site}/wp-json/wc/v3${path}${separator}per_page=${PAGE_SIZE}&page=${page}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${credentials.key}:${credentials.secret}`).toString("base64")}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Woo ${path} failed: HTTP ${response.status}`);
  return { items: (await response.json()) as T[], pages: Number(response.headers.get("x-wp-totalpages") ?? 1) };
}

async function fetchAll<T>(credentials: WooCredentials, path: string): Promise<T[]> {
  const first = await fetchPage<T>(credentials, path, 1);
  const items = [...first.items];
  for (let page = 2; page <= first.pages; page++) items.push(...(await fetchPage<T>(credentials, path, page)).items);
  return items;
}

/** Every product with its variations. */
export async function fetchListings(credentials: WooCredentials): Promise<WooListing[]> {
  const products = await fetchAll<WooProduct>(credentials, "/products");
  const listings: WooListing[] = [];
  for (const product of products) {
    const variations = product.type === "variable" ? await fetchAll<WooVariation>(credentials, `/products/${product.id}/variations`) : [];
    listings.push({ product, variations });
  }
  return listings;
}
