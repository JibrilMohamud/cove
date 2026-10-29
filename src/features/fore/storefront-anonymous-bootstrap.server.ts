/* eslint-disable prettier/prettier -- Keep bounded public projection and strict first-paint invariant adjacent for audit. */
import { networkCountry, resolveStorefrontContext } from "./localization.server";
import { projectedAnonymousHomePage, resolveStorefrontPage } from "./taxonomy.server";
import { firstPaintStorefrontShelf } from "./search.server";
import { enforceFirstPaintRateLimit } from "./storefront-read-rate-limit.server";
import type { CoveEnv } from "./api.server";

/**
 * Cloudflare Worker-only, read-only bootstrap for a *provably anonymous*
 * homepage visit. The existing all-purpose API imports payments, ingestion,
 * accounts, publishing, audio, and their transitive modules; importing it on
 * first SSR can dominate latency even when D1 queries finish quickly.
 *
 * This intentionally does not service account, authenticated, commerce,
 * reader or public API routes. Those still use handleCoveApi.
 */
export function canUseLeanAnonymousBootstrap(
  request: Request,
  env: Pick<CoveEnv, "DB" | "COVE_STOREFRONT_READ_LIMITER">,
): boolean {
  if (request.method !== "GET") return false;
  if (new URL(request.url).pathname !== "/api/fore/storefront/bootstrap") return false;
  if (new URL(request.url).search) return false;
  // A cookie or any provider identity hint forces the complete authenticated
  // adapter; never guess whether the browser might have a session.
  for (const header of [
    "authorization",
    "cookie",
    "oai-authenticated-user-id",
    "oai-authenticated-user-email",
    "x-fore-authenticated-user-id",
  ])
    if (request.headers.has(header)) return false;
  if (!/^[A-Z]{2}$/.test(request.headers.get("x-cove-client-country") || "")) return false;
  // server.ts replaces x-cove-client-country from immutable request.cf.
  // It also removes spoofable client-IP headers, leaving cf-connecting-ip.
  if (!request.headers.get("cf-connecting-ip")?.trim()) return false;
  return (
    !!env.DB &&
    typeof env.DB.prepare === "function" &&
    typeof env.COVE_STOREFRONT_READ_LIMITER?.limit === "function"
  );
}

/**
 * All three independent checks complete before returning any data. An
 * edge-side locale/market read may be a replica, but authoritative
 * country-filtered retail availability STILL queries env.DB (primary).
 * A new session is created for each independent presentation read.
 */
export async function serveLeanAnonymousBootstrap(
  request: Request,
  env: CoveEnv,
  preparedShelf?: (territory: string) => ReturnType<typeof firstPaintStorefrontShelf>,
): Promise<Response> {
  if (!canUseLeanAnonymousBootstrap(request, env))
    return new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
  const started = performance.now();
  const timings: Record<string, number> = {};
  const timed = async <T>(name: string, task: Promise<T>): Promise<T> => {
    const began = performance.now();
    try {
      return await task;
    } finally {
      timings[name] = performance.now() - began;
    }
  };
  const rawDb = env.DB!;
  // Stage evidence: geo-replica metadata sessions stalled for 1.5-5.8s
  // while the concurrently executed primary rights SQL finished in ~90ms.
  // This is PUBLIC presentation data only, but each request needs a fresh
  // authoritative market/translation view. A primary binding avoids the
  // cross-replica bootstrap/session path and is testable independently.
  // No cross-request cache or stale legal grants are introduced.
  const readMetadata = () => rawDb;
  const ip = request.headers.get("cf-connecting-ip")!.trim();
  // No cookie/account data is present. This same canonical resolver also
  // drives resolveStorefrontContext's country for anonymous visitors.
  const trustedCountry = networkCountry(request, env.FORE_DEFAULT_TERRITORY || "US").country;
  // Admission precedes every primary read. Rejected requests cannot launch
  // catalog/translation work merely by abandoning their eventual response.
  await timed("limit", enforceFirstPaintRateLimit(env, `search:catalog:ip:${ip}`, 180));
  const d1Metrics: { sqlDurationMs?: number; rowsRead?: number; attempts?: number } = {};
  let homepageRows: Record<string, unknown>[] | null = null;
  // Launch the authoritative primary-rights query *before* waiting for
  // fresh primary presentation reads. No book leaves the Worker until
  // the rate limiter, markets, context, page and rights checks ALL succeed.
  const contextPromise = timed(
    "context",
    resolveStorefrontContext(
      readMetadata(),
      request,
      null,
      env.FORE_DEFAULT_TERRITORY || "US",
      true,
      (rows) => { homepageRows = rows; },
    ),
  );
  const pagePromise = contextPromise.then((context) =>
    timed(
      "page",
      homepageRows && homepageRows.length <= 64
        ? Promise.resolve(
            projectedAnonymousHomePage(
              homepageRows,
              context.rightsCountry,
              context.language,
            ),
          )
        : resolveStorefrontPage(
            readMetadata(),
            "/",
            context.rightsCountry,
            context.language,
            context.locale,
          ),
    ),
  );
  const [context, catalog, page] = await Promise.all([
    contextPromise,
    // NULL currency means active-market currency is looked up in this SAME
    // live primary D1 statement with the full retail-grant view.
    timed(
      "catalog",
      preparedShelf
        ? preparedShelf(trustedCountry)
        : firstPaintStorefrontShelf(env, null, trustedCountry, d1Metrics),
    ),
    pagePromise,
  ]);
  if (context.rightsCountry !== trustedCountry)
    throw new Error("Anonymous country mismatch; refuse to render a legal-rights shelf.");
  // Only the presentation projection is combined. No entitlement data comes
  // from the market list, and the primary D1 rights query above must finish.
  const { availableMarkets, ...publicContext } = context;
  if (!Array.isArray(availableMarkets))
    throw new Error("Anonymous market projection is unavailable.");
  const query = new URLSearchParams({
    search: "",
    sort: "popular",
    page: "1",
    currency: context.currency,
  }).toString();
  if (catalog.next) {
    const nextQuery = new URLSearchParams(query);
    nextQuery.set("page", "2");
    catalog.next = `/api/fore/catalog?${nextQuery}`;
  }
  // Keep measured actual primary SQL duration, rows read and retries separate
  // from the full D1 service/network request duration.
  if (d1Metrics.sqlDurationMs !== undefined) timings.catalog_sql = d1Metrics.sqlDurationMs;

  timings.bootstrap = performance.now() - started;
  timings.lean = 0;
  return new Response(
    JSON.stringify({
      context: { ...publicContext, availableMarkets },
      page,
      catalog,
      catalogQuery: query,
      at: Date.now(),
    }),
    {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Server-Timing": [
          ...Object.entries(timings).map(([name, ms]) => `cove_${name};dur=${ms.toFixed(1)}`),
          // These are counts, not milliseconds. Expose as numeric descriptions
          // so browser tooling never mistakes rows read for elapsed time.
          ...(d1Metrics.rowsRead !== undefined
            ? [`cove_catalog_rows;desc="${Math.round(d1Metrics.rowsRead)}"`]
            : []),
          ...(d1Metrics.attempts !== undefined
            ? [`cove_catalog_attempts;desc="${Math.round(d1Metrics.attempts)}"`]
            : []),
        ].join(", "),
      },
    },
  );
}
