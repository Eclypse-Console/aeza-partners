// Compares one brand's rows in catalog_products (the new catalog) with the
// legacy products table, field by field, in the main products database.
// Read-only.
//
//   npm run catalog:compare -- --shop brandx.myshopify.com [--examples 3]
//
// Runs on Node's built-in TypeScript support (Node >= 22.18).

import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";
import { PRODUCT_COLUMNS, selectList } from "../app/services/catalog/columns.ts";

const { values } = parseArgs({
  options: {
    shop: { type: "string" },
    examples: { type: "string", default: "3" },
  },
});
const shop = values.shop?.trim().toLowerCase() ?? "";
const examples = Number(values.examples);

if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
  console.error("catalog:compare: --shop must look like brandx.myshopify.com");
  process.exit(1);
}

// Bookkeeping columns that always differ and say nothing about data quality.
const SKIPPED = new Set(["updated_at", "created_at", "ingested_at", "last_vectorized_at", "product_image_siglip_at", "data_version"]);
const VECTORS = new Set(["multimodal_product_embeddings", "product_image_siglip_embedding"]);

const legacy = new PrismaClient({ datasourceUrl: process.env.PRODUCTS_DB });

const show = (value: unknown) => {
  const text = JSON.stringify(value) ?? "null";
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const empty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

try {
  const columns = selectList(PRODUCT_COLUMNS, "n");
  const newRows = await legacy.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT ${columns}, n.color_key, n.source, n.is_available, n.sizes_in_stock FROM catalog_products n WHERE n.shop = $1 ORDER BY n.handle, n.color_key`,
    shop,
  );
  if (!newRows.length) throw new Error(`no catalog_products rows for ${shop}; run catalog:sync --publish first`);
  const ids = newRows.map((r) => r.id as string);
  const oldRows = await legacy.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT ${selectList(PRODUCT_COLUMNS)} FROM products WHERE id = ANY($1::uuid[])`,
    ids,
  );
  const oldById = new Map(oldRows.map((r) => [r.id as string, r]));
  const brand = newRows[0].brand;
  const [{ n: legacyTotal }] = await legacy.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*) AS n FROM products WHERE brand = $1`,
    brand,
  );

  const matched = newRows.filter((r) => oldById.has(r.id as string));
  console.log(`# ${brand} (${shop}): old vs new\n`);
  console.log(`| | Old products | New catalog_products |`);
  console.log(`|---|---|---|`);
  console.log(`| Rows | ${legacyTotal} | ${newRows.length} (${matched.length} with the same id, ${newRows.length - matched.length} new) |`);
  console.log(`| Active | ${matched.filter((r) => oldById.get(r.id as string)!.is_active).length} of the matched | ${newRows.filter((r) => r.is_active).length} |`);
  console.log(`| Available to buy now | not tracked | ${newRows.filter((r) => r.is_available).length} |`);
  for (const vector of VECTORS) {
    console.log(`| ${vector} present | ${oldRows.filter((r) => !empty(r[vector])).length} | ${newRows.filter((r) => !empty(r[vector])).length} |`);
  }

  console.log(`\n## Field differences on the ${matched.length} matched rows\n`);
  console.log(`| Field | Changed | Filled (was empty) | Emptied | Example (old → new) |`);
  console.log(`|---|---|---|---|---|`);
  for (const field of Object.keys(PRODUCT_COLUMNS)) {
    if (field === "id" || SKIPPED.has(field)) continue;
    let changed = 0;
    let filled = 0;
    let emptied = 0;
    const samples: string[] = [];
    for (const row of matched) {
      const before = oldById.get(row.id as string)![field];
      const after = row[field];
      // null and [] mean the same thing to every reader of these columns.
      if ((empty(before) && empty(after)) || same(before, after)) continue;
      if (empty(before) && !empty(after)) filled++;
      else if (!empty(before) && empty(after)) emptied++;
      else changed++;
      if (samples.length < examples && !VECTORS.has(field)) samples.push(`${row.handle}: ${show(before)} → ${show(after)}`);
    }
    if (changed + filled + emptied === 0) continue;
    console.log(`| ${field} | ${changed} | ${filled} | ${emptied} | ${samples.join("<br>")} |`);
  }

  const created = newRows.filter((r) => !oldById.has(r.id as string));
  if (created.length) {
    console.log(`\n## New rows\n`);
    for (const row of created) {
      const gaps = ["ai_description", "occasion", "aesthetic", "season", "fit", "color_hex", "multimodal_product_embeddings", "product_image_siglip_embedding"].filter((f) => empty(row[f]));
      console.log(`- ${row.handle}${row.color_key ? ` [${row.color_key}]` : ""}: ${row.title}; colours ${show(row.primary_colors)}; sizes in stock ${show(row.sizes_in_stock)}; still missing: ${gaps.join(", ") || "nothing"}`);
    }
  }
} finally {
  await legacy.$disconnect();
}
