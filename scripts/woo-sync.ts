// Copies Knit Domain's WooCommerce products into the catalog tables on the
// catalog branch. Reads Woo with GET only. Rows stay hidden (is_active false)
// unless --live is passed, which needs checkout to work for this store.
//
//   npm run woo:sync -- [--dry-run] [--live]
//
// Runs on Node's built-in TypeScript support (Node >= 22.18).

import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";
import { fetchListings, wooCredentials } from "../app/services/woo/client.server.ts";
import { KNIT_DOMAIN, syncWooCatalog } from "../app/services/woo/sync.server.ts";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    live: { type: "boolean", default: false },
  },
});

const url = process.env.WOO_CATALOG_DATABASE_URL;
if (!url) {
  console.error("woo:sync: WOO_CATALOG_DATABASE_URL is not set");
  process.exit(1);
}

const catalogDb = new PrismaClient({ datasourceUrl: url });

try {
  const listings = await fetchListings(wooCredentials());
  const plan = await syncWooCatalog({ catalogDb, listings, hidden: !values.live, dryRun: values["dry-run"] });

  console.error(`Woo products: ${listings.length}, catalog rows: ${plan.rows.length}, sizes: ${plan.variants.length}, removed: ${plan.deletes.length}`);
  console.error(values["dry-run"] ? "Dry run: nothing written." : `Written for ${KNIT_DOMAIN.shop} (${values.live ? "live" : "hidden"}).`);
} finally {
  await catalogDb.$disconnect();
}
