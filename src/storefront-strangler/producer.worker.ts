import { produceCandidateSnapshot } from "./prepared-catalog.server";
import type { CatalogDB } from "../features/fore/catalog-model.server";

type ProjectionProducerEnv = {
  DB: CatalogDB;
  PRESENTATION: {
    put(
      key: string,
      value: string,
      opts: { httpMetadata: { contentType: string } },
    ): Promise<unknown>;
  };
  COVE_SSR_STAGING?: string;
  COVE_STRANGLER_MODE?: string;
  COVE_STRANGLER_DATABASE_ID?: string;
};

export function allowedProjectionProducer(env: ProjectionProducerEnv) {
  // Both explicit runtime guards and the separately checked Wrangler
  // binding ID must match. This Worker has no public HTTP routes or secrets.
  return (
    env.COVE_SSR_STAGING === "1" &&
    env.COVE_STRANGLER_MODE === "isolated-evaluation" &&
    env.COVE_STRANGLER_DATABASE_ID === "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3" &&
    typeof env.DB?.prepare === "function" &&
    typeof env.PRESENTATION?.put === "function"
  );
}

/** On-demand scheduled publisher, never invoked by a storefront request.
 * Scheduling is intentionally omitted from checked staging infrastructure:
 * an operator must explicitly provision its private bucket and cron.
 */
export default {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  },
  scheduled(
    controller: { cron: string },
    env: ProjectionProducerEnv,
    ctx: { waitUntil(task: Promise<unknown>): void },
  ) {
    if (controller.cron !== "*/5 * * * *" || !allowedProjectionProducer(env))
      throw Error("Candidate producer has no approved scheduled execution.");
    ctx.waitUntil(
      (async () => {
        const markets = await env.DB.prepare(
          "SELECT country_code FROM storefront_markets WHERE market_status='active' ORDER BY country_code LIMIT 33",
        ).all<{ country_code: string }>();
        if (!markets.results.length || markets.results.length > 32)
          throw Error("Unbounded or missing market configuration.");
        for (const market of markets.results) {
          const country = String(market.country_code);
          if (!/^[A-Z]{2}$/.test(country)) throw Error("Invalid active market.");
          await produceCandidateSnapshot(env.DB, country, env.PRESENTATION);
        }
      })(),
    );
  },
};
