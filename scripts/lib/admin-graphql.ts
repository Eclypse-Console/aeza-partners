// Admin GraphQL client for the store:* and catalog:* scripts. Retries when
// Shopify throttles us, waiting for the query-cost bucket to refill
// (restoreRate points per second), and records the most expensive query.

const API_VERSION = "2026-07";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type AdminGraphql = (<T>(query: string, variables?: Record<string, unknown>) => Promise<T>) & {
  maxQueryCost: () => number;
};

export function createAdminGraphql(shop: string, accessToken: string): AdminGraphql {
  let maxQueryCost = 0;

  async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables }),
      });
      if (response.status === 429 || response.status >= 500) {
        if (attempt >= 5) throw new Error(`Shopify HTTP ${response.status}`);
        await sleep(2_000 * attempt);
        continue;
      }
      if (!response.ok) throw new Error(`Shopify HTTP ${response.status}`);

      const body = (await response.json()) as {
        data?: T;
        errors?: Array<{ message: string; extensions?: { code?: string } }>;
        extensions?: {
          cost?: {
            requestedQueryCost: number;
            throttleStatus: { currentlyAvailable: number; restoreRate: number };
          };
        };
      };
      const cost = body.extensions?.cost;
      if (cost) maxQueryCost = Math.max(maxQueryCost, cost.requestedQueryCost);
      const throttled = body.errors?.some((e) => e.extensions?.code === "THROTTLED");
      if (throttled && attempt < 5) {
        const missing = (cost?.requestedQueryCost ?? 100) - (cost?.throttleStatus.currentlyAvailable ?? 0);
        await sleep(Math.max(1_000, (missing / (cost?.throttleStatus.restoreRate ?? 50)) * 1_000));
        continue;
      }
      if (body.errors?.length) {
        throw new Error(body.errors.map((e) => e.message).join("; "));
      }
      // Slow down before the bucket runs dry rather than after.
      if (cost && cost.throttleStatus.currentlyAvailable < cost.requestedQueryCost * 2) {
        await sleep((cost.requestedQueryCost / cost.throttleStatus.restoreRate) * 1_000);
      }
      return body.data as T;
    }
  }

  return Object.assign(graphql, { maxQueryCost: () => maxQueryCost });
}
