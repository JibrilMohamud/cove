import { produceHomepagePresentation } from "./homepage-presentation.server";
import type { StorefrontDB } from "./localization-optimized.server";
import {
  namespacedPresentationStore,
  type PrivatePresentationStore,
} from "./prepared-catalog.server";

type Env = {
  // This deployment has no binding to the rights/transaction primary.
  DISCOVERY_DB: StorefrontDB;
  PRESENTATION: PrivatePresentationStore & {
    put(
      key: string,
      body: string,
      options: { httpMetadata: { contentType: string } },
    ): Promise<unknown>;
  };
  COVE_DISCOVERY_DATABASE_ID: string;
  COVE_DISCOVERY_PRODUCER_ENABLED?: string;
  COVE_PRESENTATION_PREFIX?: string;
};

export async function publishIsolatedHomepage(env: Env) {
  if (
    env.COVE_DISCOVERY_PRODUCER_ENABLED !== "1" ||
    env.COVE_DISCOVERY_DATABASE_ID !== "cc842ee5-c526-431e-96ee-5e093fb45e6d"
  )
    throw Error("Isolated discovery producer disabled");
  const markets = await env.DISCOVERY_DB.prepare(
    "SELECT country_code FROM storefront_markets WHERE market_status='active' ORDER BY country_code LIMIT 33",
  ).all<{ country_code: string }>();
  if (!markets.results.length || markets.results.length > 32)
    throw Error("Unbounded market configuration");
  const results = [];
  const prefix = env.COVE_PRESENTATION_PREFIX || "";
  const store = {
    ...namespacedPresentationStore(env.PRESENTATION, prefix),
    put: (key: string, body: string, options: { httpMetadata: { contentType: string } }) =>
      env.PRESENTATION.put(prefix + key, body, options),
  };
  for (const m of markets.results)
    results.push(await produceHomepagePresentation(env.DISCOVERY_DB, m.country_code, store));
  return results;
}

export default {
  async fetch() {
    return new Response(null, { status: 404 });
  },
  scheduled(_controller: unknown, env: Env, ctx: { waitUntil(task: Promise<unknown>): void }) {
    ctx.waitUntil(publishIsolatedHomepage(env));
  },
};
