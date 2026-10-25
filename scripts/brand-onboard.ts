// Onboards a brand end to end, as far as Shopify allows from a terminal:
//
//   npm run brand:onboard -- --shop brandx.myshopify.com --brand-name "Brand X"
//   npm run brand:onboard -- --shop brandx.com          (website or alias works too)
//   npm run brand:onboard -- --shop brandx.myshopify.com --client-id <id>   (app already exists)
//
// The full checklist is docs/brand-onboarding.md.
//
//   1. Creates the brand's private app with Shopify CLI (`app config link`: pick the
//      "Aeza - public" org, then "create a new app"). Skipped when --client-id is given.
//   2. Reads the app's client secret with `app env show`, straight into store:add
//      (never printed, never on a command line).
//   3. store:add: encrypts and saves the credentials, writes shopify.app.<slug>.toml.
//   4. Prints the two steps left: custom distribution (dashboard only, no CLI/API)
//      and `app deploy`, which fails until distribution is set.
//
// Runs on Node's built-in TypeScript support (Node >= 22.18).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolveShop } from "./brand-lib.ts";

const { values } = parseArgs({
  options: {
    shop: { type: "string" },
    "brand-name": { type: "string" },
    "client-id": { type: "string" },
  },
});

function fail(message: string): never {
  console.error(`brand:onboard: ${message}`);
  process.exit(1);
}

// --shop can be the store's address, an alias or the brand's website: the app
// must be tied to the permanent *.myshopify.com domain, so look that up.
const input = values.shop?.trim() ?? "";
if (!input) fail("--shop is required (store address or the brand's website)");
const store = await resolveShop(input);
if (!store) {
  fail(`couldn't find a live Shopify store at "${input}". Ask the brand for Settings -> Domains.`);
}
const shop = store.shop;
const brandName = values["brand-name"]?.trim() || store.name || undefined;
console.log(`Store: ${store.name} (${store.website}) -> ${shop}`);
if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) fail(`unexpected store domain ${shop}`);
const slug = shop.replace(/\.myshopify\.com$/, "");

// Every value reaching a shell below is validated to [A-Za-z0-9-], so shell
// mode (needed for npx on Windows) can't be injected into.
function shopifyCli(args: string[], capture = false) {
  const result = spawnSync("npx", ["shopify", ...args], {
    shell: true,
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) fail(`shopify ${args.slice(0, 2).join(" ")} failed`);
  return result.stdout ?? "";
}

// 1. Create the app (or link the one given) into a temporary config, which the
// CLI needs to read the secret. store:add then writes the real config.
const linkName = `${slug}-link`;
const linkFile = `shopify.app.${linkName}.toml`;
const givenClientId = values["client-id"]?.trim() ?? "";
if (givenClientId) {
  if (!/^[A-Za-z0-9]+$/.test(givenClientId)) fail("--client-id looks wrong");
  shopifyCli(["app", "config", "link", "--client-id", givenClientId, "--file-name", linkFile, "--force"]);
} else {
  console.log(
    `\nCreating the app. When asked: choose the "Aeza - public" org, ` +
      `then "create a new app" and name it "Aeza Partner - ${brandName ?? slug}".\n`,
  );
  shopifyCli(["app", "config", "link", "--file-name", linkFile]);
}
if (!existsSync(linkFile)) fail(`expected ${linkFile} from the CLI`);
const clientId = readFileSync(linkFile, "utf8").match(/^client_id\s*=\s*"([^"]+)"/m)?.[1] ?? "";
if (!/^[A-Za-z0-9]+$/.test(clientId)) fail(`no client id in ${linkFile}`);
console.log(`App client id: ${clientId}`);

// 2. Read the secret without showing it.
let clientSecret: string | undefined;
try {
  const env = shopifyCli(["app", "env", "show", "--config", linkName], true);
  clientSecret = env.match(/SHOPIFY_API_SECRET=(\S+)/)?.[1];
} finally {
  rmSync(linkFile, { force: true });
}
if (!clientSecret) fail("could not read the app's client secret from `shopify app env show`");

// 3. Save the store (encrypted) and write shopify.app.<slug>.toml.
const add = spawnSync(
  process.execPath,
  [
    "--env-file-if-exists=.env",
    "scripts/store-add.ts",
    "--shop",
    shop,
    "--client-id",
    clientId,
    ...(brandName ? ["--brand-name", brandName] : []),
  ],
  { stdio: "inherit", env: { ...process.env, STORE_CLIENT_SECRET: clientSecret } },
);
if (add.status !== 0) fail("store:add failed");

// 4. The deploy is left to the user: Shopify refuses the order and fulfilment
// webhooks (protected customer data) until the app has a distribution method,
// which can only be set in the dashboard. (A prompt here can't wait for it: on
// Windows the CLI leaves stdin unreadable.)
console.log(`
Registered ${shop} (client id ${clientId}). Two steps left:

  1. Dev Dashboard -> the app -> Distribution -> Custom distribution -> ${shop}
     -> copy the install link (don't send it yet).
  2. npm run brand:deploy -- --shop ${shop}

Then send the brand the install link. Check progress any time with:
  npm run brand:status -- --shop ${shop}
`);
