import {
  networkCountry,
  resolveStorefrontContext,
  resolveAnonymousStorefrontContext,
} from "./localization.server";
import {
  prefetchAnonymousHomepageCandidates,
  resolvePrefetchedAnonymousHomepage,
} from "./taxonomy.server";
import { firstPaintStorefrontShelf } from "./search.server";
import { enforceFirstPaintRateLimit } from "./storefront-read-rate-limit.server";
import { singleflightAnonymousPresentation } from "./anonymous-context-singleflight.server";
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
    "x-fore-authenticated-user-email",
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
  const configDb = rawDb as typeof rawDb & {
    withSession?: (constraint: "first-unconstrained") => typeof rawDb;
  };
  const readMetadata = () =>
    typeof configDb.withSession === "function"
      ? configDb.withSession("first-unconstrained")
      : rawDb;
  const ip = request.headers.get("cf-connecting-ip")!.trim();
  // No cookie/account data is present. This same canonical resolver also
  // drives resolveStorefrontContext's country for anonymous visitors.
  const trustedCountry = networkCountry(request, env.FORE_DEFAULT_TERRITORY || "US").country;
  const d1Metrics: { sqlDurationMs?: number; rowsRead?: number; attempts?: number } = {};
  // Launch the authoritative primary-rights query *before* waiting for
  // independent replica presentation reads. No book leaves the Worker until
  // the rate limiter, markets, context, page and rights checks ALL succeed.
  const resolveContext = () =>
    env.COVE_SSR_STAGING === "1" &&
    (env as CoveEnv & { FORE_ANON_CONTEXT_ONE_READ?: string }).FORE_ANON_CONTEXT_ONE_READ === "1"
      ? resolveAnonymousStorefrontContext(
          readMetadata(),
          request,
          env.FORE_DEFAULT_TERRITORY || "US",
          true,
        )
      : resolveStorefrontContext(
          readMetadata(),
          request,
          null,
          env.FORE_DEFAULT_TERRITORY || "US",
          true,
        );
  const contextPromise = timed(
    "context",
    (env as CoveEnv & { FORE_ANON_CONTEXT_SINGLEFLIGHT?: string })
      .FORE_ANON_CONTEXT_SINGLEFLIGHT === "1"
      ? singleflightAnonymousPresentation(rawDb, request, trustedCountry, true, resolveContext)
      : resolveContext(),
  );
  // Home-page branding is a presentation read, not a rights grant. Fetch
  // its bounded candidates concurrently with the market and authoritative
  // live catalog queries, then apply the resolved language. Ambiguous
  // overlapping page definitions use the original exact D1 selector.
  const pageMetadata = readMetadata();
  const homeCandidatesPromise = timed(
    "page_prefetch",
    prefetchAnonymousHomepageCandidates(pageMetadata, trustedCountry),
  );
  const pagePromise = Promise.all([contextPromise, homeCandidatesPromise]).then(
    ([context, candidates]) =>
      timed(
        "page",
        resolvePrefetchedAnonymousHomepage(
          pageMetadata,
          candidates,
          context.rightsCountry,
          context.language,
          context.locale,
        ),
      ),
  );
  const [context, , catalog, page] = await Promise.all([
    contextPromise,
    timed("limit", enforceFirstPaintRateLimit(env, `search:catalog:ip:${ip}`, 180)),
    // NULL currency means active-market currency is looked up in this SAME
    // live primary D1 statement with the full retail-grant view.
    timed("catalog", firstPaintStorefrontShelf(env, null, trustedCountry, d1Metrics)),
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
