// Builds one brand's catalog in aeza-ops from its Shopify products and the
// legacy products table, then (with --publish) copies it to catalog_products
// in the main products database. The app does the same by itself after each
// full sync and on product webhooks when CATALOG_SYNC=on; this runs it by
// hand (and shows the plan with --dry-run).
//
//   npm run catalog:sync -- --shop brandx.myshopify.com [--dry-run] [--publish]
//                           [--legacy-brand "Brand X"] [--publish-only]
//
// Enrichment for the queued gaps runs in the Enrichment System:
//   python scripts/run_catalog_enrichment.py --shop brandx.myshopify.com
//
// Runs on Node's built-in TypeScript support (Node >= 22.18).

import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";
import { getAccessToken } from "./lib/access-token.ts";
import { createAdminGraphql } from "./lib/admin-graphql.ts";
import { runCatalogSync } from "../app/services/catalog/run.server.ts";
import { publishShop } from "../app/services/catalog/publish.server.ts";

const { values } = parseArgs({
  options: {
    shop: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    publish: { type: "boolean", default: false },
    "publish-only": { type: "boolean", default: false },
    "legacy-brand": { type: "string" },
  },
});
const shop = values.shop?.trim().toLowerCase() ?? "";

function fail(message: string): never {
  console.error(`catalog:sync: ${message}`);
  process.exit(1);
}

if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) fail("--shop must look like brandx.myshopify.com");
if (!process.env.PRODUCTS_DB) fail("PRODUCTS_DB (the main products database) is not set");

const ops = new PrismaClient();
const legacy = new PrismaClient({ datasourceUrl: process.env.PRODUCTS_DB });

const count = <T>(items: T[], key: (item: T) => string) =>
  items.reduce<Record<string, number>>((acc, item) => ((acc[key(item)] = (acc[key(item)] ?? 0) + 1), acc), {});

try {
  if (values["publish-only"]) {
    const published = await publishShop(ops, legacy, shop);
    console.error(`Published ${published} rows to catalog_products.`);
  } else {
    const { accessToken } = await getAccessToken(ops, shop);
    const { plan, brand, legacyRows, products, missingFromMirror, metaobjects } = await runCatalogSync({
      ops,
      legacy,
      shop,
      graphql: createAdminGraphql(shop, accessToken),
      legacyBrandName: values["legacy-brand"],
      dryRun: values["dry-run"],
    });
    if (!products) fail(`no products for ${shop} in full_ShopifyProducts; run store:full-export first`);

    console.error(
      brand
        ? `Legacy brand: ${brand.name} (${brand.id}), ${legacyRows} rows${brand.matchedHandles ? `, ${brand.matchedHandles} handles in common` : ""}`
        : "No legacy rows for this store: every product is new",
    );
    console.error(`Attribute values: ${metaobjects.total - metaobjects.unresolved}/${metaobjects.total} resolved${metaobjects.unresolved ? " (the store app lacks read_metaobjects for the rest)" : ""}`);
    console.error(`\nShopify products: ${products}, catalog rows: ${plan.rows.length}, sizes: ${plan.variants.length}`);
    console.error("Rows by source:", count(plan.rows, (r) => r.source));
    console.error("Live on Aeza:", plan.rows.filter((r) => r.live_on_aeza).length, "| available:", plan.rows.filter((r) => r.is_available).length);
    console.error("Links:", count(plan.links, (l) => `${l.status}/${l.method}`));
    console.error("Removed from the catalog:", plan.deletes.length);
    if (missingFromMirror) {
      console.error(`${missingFromMirror} published products aren't in full_ShopifyProducts yet: run store:full-export or a full sync.`);
    }
    for (const note of plan.notes) console.error(`  - ${note.handle}${note.colorKey ? ` [${note.colorKey}]` : ""}: ${note.note}`);

    if (values["dry-run"]) {
      console.error("\nDry run: nothing written.");
    } else {
      console.error("\nWritten to shopify_connector.CatalogProduct / CatalogVariant / CatalogProductLink.");
      if (values.publish) {
        const published = await publishShop(ops, legacy, shop);
        console.error(`Published ${published} rows to catalog_products.`);
      }
    }
  }
} finally {
  await ops.$disconnect();
  await legacy.$disconnect();
}
