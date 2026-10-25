// Copies every product of one store, with all the detail Shopify has, into
// shopify_connector."full_ShopifyProducts" (see
// app/services/catalog/full-products.server.ts). One row per product,
// upserted on (shop, productId), so re-running it refreshes the rows.
// The app keeps this table current by itself (bulk sync + webhooks); this is
// for a manual refresh or backfill.
//
//   npm run store:full-export -- --shop brandx.myshopify.com [--dry-run]
//
// --dry-run fetches everything and prints a summary without writing.
// Read-only towards Shopify.
//
// Runs on Node's built-in TypeScript support (Node >= 22.18).

import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";
import { getAccessToken } from "./lib/access-token.ts";
import { createAdminGraphql } from "./lib/admin-graphql.ts";
import {
  ensureFullColumns,
  fetchFullProduct,
  fetchProductIds,
  saveFullProduct,
} from "../app/services/catalog/full-products.server.ts";

const { values } = parseArgs({
  options: {
    shop: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
const shop = values.shop?.trim().toLowerCase() ?? "";
const dryRun = values["dry-run"];

function fail(message: string): never {
  console.error(`store:full-export: ${message}`);
  process.exit(1);
}

if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
  fail("--shop must look like brandx.myshopify.com");
}

const prisma = new PrismaClient();

try {
  const { accessToken } = await getAccessToken(prisma, shop).catch((error: Error) =>
    fail(error.message),
  );

  const graphql = createAdminGraphql(shop, accessToken);
  const ids = await fetchProductIds(graphql);
  console.error(`${ids.length} products in ${shop}${dryRun ? " (dry run, nothing is written)" : ""}`);
  if (!dryRun) await ensureFullColumns(prisma);

  let saved = 0;
  let variantCount = 0;
  const failed: string[] = [];
  for (const [index, id] of ids.entries()) {
    try {
      const product = await fetchFullProduct(graphql, id);
      if (!product) {
        failed.push(`${id}: not found`);
        continue;
      }
      variantCount += product.variants.nodes.length;
      if (!dryRun) await saveFullProduct(prisma, shop, product);
      saved++;
    } catch (error) {
      failed.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if ((index + 1) % 25 === 0) console.error(`  ${index + 1}/${ids.length}`);
  }

  console.error(
    `${dryRun ? "Fetched" : "Saved"} ${saved} products (${variantCount} variants); ${failed.length} failed. Highest query cost: ${graphql.maxQueryCost()}.`,
  );
  for (const line of failed) console.error(`  failed ${line}`);
  if (failed.length) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
