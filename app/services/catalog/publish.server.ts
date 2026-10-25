// Publishes catalog rows one way, aeza-ops -> main products database, into
// catalog_products: the products table's shape (same columns, defaults and
// indexes, so apps can switch to it by table name) plus a few catalog
// columns. Nothing else writes catalog_products, and the legacy products
// table is never touched.

import type { PrismaClient } from "@prisma/client";
import { PRODUCT_COLUMNS, PUBLISHED_EXTRA_COLUMNS, selectList, upsertSql } from "./columns.ts";

const PUBLISHED_COLUMNS = { ...PRODUCT_COLUMNS, ...PUBLISHED_EXTRA_COLUMNS };
const SQL_TYPES: Record<string, string> = { "text[]": "text[]", numeric: "numeric(12,2)", int: "integer", bool: "boolean", timestamp: "timestamp", text: "text" };
const BATCH = 50;

export async function ensurePublishedTable(legacy: PrismaClient): Promise<void> {
  await legacy.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS catalog_products (LIKE products INCLUDING DEFAULTS INCLUDING INDEXES)`,
  );
  for (const [name, type] of Object.entries(PUBLISHED_EXTRA_COLUMNS)) {
    await legacy.$executeRawUnsafe(
      `ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS "${name}" ${SQL_TYPES[type] ?? type}`,
    );
  }
  await legacy.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS catalog_products_shop_idx ON catalog_products (shop)`);
}

/** Copies every catalog row of one shop to catalog_products; returns how many. */
export async function publishShop(ops: PrismaClient, legacy: PrismaClient, shop: string): Promise<number> {
  await ensurePublishedTable(legacy);
  const rows = await ops.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT ${selectList(PUBLISHED_COLUMNS)} FROM shopify_connector."CatalogProduct" WHERE shop = $1`,
    shop,
  );
  for (let start = 0; start < rows.length; start += BATCH) {
    const { sql, params } = upsertSql("catalog_products", PUBLISHED_COLUMNS, rows.slice(start, start + BATCH), { applyDefaults: false });
    await legacy.$executeRawUnsafe(sql, ...params);
  }
  return rows.length;
}
