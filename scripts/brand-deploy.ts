// Pushes a brand's app config (scopes, webhooks, URLs) to Shopify.
//
//   npm run brand:deploy -- --shop brandx.myshopify.com
//
// Rebuilds shopify.app.<slug>.toml from the template first, so template changes
// reach every brand. Run it after setting custom distribution: until then Shopify
// refuses the order webhooks. If it still refuses them, the app is deployed
// without them (catalog sync works, orders can't be tracked yet) and the script
// says so; run it again later to add them.
//
// Runs on Node's built-in TypeScript support (Node >= 22.18).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fail, renderToml, shopifyCli, slugOf, tomlPathOf, tomlValue } from "./brand-lib.ts";

const { values } = parseArgs({ options: { shop: { type: "string" } } });
const shop = values.shop?.trim().toLowerCase() ?? "";
if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
  fail("brand:deploy", "--shop must look like brandx.myshopify.com");
}

const tomlPath = tomlPathOf(shop);
if (!existsSync(tomlPath)) fail("brand:deploy", `${tomlPath} not found; run brand:onboard first`);
const current = readFileSync(tomlPath, "utf8");
const clientId = tomlValue(current, "client_id") ?? "";
const appName = tomlValue(current, "name") ?? "";
if (!/^[A-Za-z0-9]+$/.test(clientId) || !appName) fail("brand:deploy", `${tomlPath} has no client_id/name`);

const deploy = () =>
  shopifyCli(["app", "deploy", "--config", slugOf(shop), "--allow-updates", "--message", "brand-deploy"]);

writeFileSync(tomlPath, renderToml(clientId, appName));
let result = await deploy();

if (result.code !== 0 && /protected customer data/i.test(result.output)) {
  console.log("\nShopify refused the order webhooks. Deploying without them so the brand can install...\n");
  writeFileSync(tomlPath, renderToml(clientId, appName, { withoutOrderTopics: true }));
  result = await deploy();
  if (result.code === 0) {
    console.log(`
Deployed WITHOUT order webhooks. The brand can install now and their catalog syncs.
Before their first Aeza order, run this again:  npm run brand:deploy -- --shop ${shop}
(If it keeps refusing: check the app's custom distribution is set to ${shop}.)`);
    process.exit(0);
  }
}
if (result.code !== 0) fail("brand:deploy", "deploy failed (see above)");
console.log(`\nDeployed ${appName} with all webhooks. Send the brand the install link.`);
