import { networkCountry, resolveAnonymousHomepageContext } from "./localization-optimized.server";
import { formatGenericStorefrontPageRecord } from "./page-record";
import {
  firstPaintStorefrontShelf,
  liveRightsForAnonymousPresentationSeeds,
} from "../features/fore/search.server";
import { enforceFirstPaintRateLimit } from "../features/fore/storefront-read-rate-limit.server";
import type { CoveEnv } from "../features/fore/api.server";
type OptimizedEnv = CoveEnv & {
  COVE_SSR_DIAGNOSTICS?: string;
  COVE_THIN_METADATA_COALESCE?: string;
  COVE_THIN_RIGHTS_SHORTLIST?: string;
  COVE_THIN_PRESENTATION_CACHE?: string;
};

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
// Promise-level coalescing only: isolate-local; no settled metadata or rights cache.
const pendingAnonymousMetadata = new WeakMap<
  object,
  Map<string, Promise<Awaited<ReturnType<typeof resolveAnonymousHomepageContext>>>>
>();
function anonymousMetadataFlight(
  binding: object,
  key: string,
  create: () => Promise<Awaited<ReturnType<typeof resolveAnonymousHomepageContext>>>,
) {
  let pending = pendingAnonymousMetadata.get(binding);
  if (!pending) {
    pending = new Map();
    pendingAnonymousMetadata.set(binding, pending);
  }
  const existing = pending.get(key);
  if (existing) return { task: existing, joined: true };
  const task = Promise.resolve().then(create);
  pending.set(key, task);
  task.then(
    () => {
      if (pending!.get(key) === task) pending!.delete(key);
    },
    () => {
      if (pending!.get(key) === task) pending!.delete(key);
    },
  );
  return { task, joined: false };
}
// A *presentation candidate list*, not an authorization cache. Every request
// still sends these IDs through the original rights-filtered primary-D1 view.
// Isolate-local state expires quickly and is never shared between countries.
const pendingAnonymousCandidateSeeds = new WeakMap<
  object,
  Map<
    string,
    {
      ids: string[];
      books: Awaited<ReturnType<typeof firstPaintStorefrontShelf>>["results"];
      hasMore: boolean;
      expiresAt: number;
    }
  >
>();
export async function serveLeanAnonymousBootstrap(
  request: Request,
  env: OptimizedEnv,
  onFailure?: (phase: string, error: unknown) => void,
): Promise<Response> {
  if (!canUseLeanAnonymousBootstrap(request, env))
    return new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
  const started = performance.now();
  const timings: Record<string, number> = {};
  const timed = async <T>(name: string, task: Promise<T>): Promise<T> => {
    const began = performance.now();
    try {
      return await task;
    } catch (error) {
      onFailure?.(name, error);
      throw error;
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
  const contextMetrics: {
    sqlDurationMs?: number;
    rowsRead?: number;
    measuredStatements?: number;
  } = {};
  const seedEnabled = env.COVE_SSR_STAGING === "1" && env.COVE_THIN_RIGHTS_SHORTLIST === "1";
  const seedKey = trustedCountry + ":" + (env.FORE_DEFAULT_TERRITORY || "US");
  let seedBucket = pendingAnonymousCandidateSeeds.get(rawDb);
  if (seedEnabled && !seedBucket) {
    seedBucket = new Map();
    pendingAnonymousCandidateSeeds.set(rawDb, seedBucket);
  }
  const existingSeed = seedEnabled ? seedBucket?.get(seedKey) : undefined;
  const candidateSeed =
    existingSeed && existingSeed.expiresAt > Date.now() ? existingSeed : undefined;
  const reusePresentation =
    !!candidateSeed && env.COVE_THIN_PRESENTATION_CACHE === "1" && seedEnabled;
  // Launch the authoritative primary-rights query *before* waiting for
  // independent replica presentation reads. No book leaves the Worker until
  // the rate limiter, markets, context, page and rights checks ALL succeed.
  const fetchContext = () =>
    resolveAnonymousHomepageContext(
      readMetadata(),
      request,
      env.FORE_DEFAULT_TERRITORY || "US",
      contextMetrics,
    );
  const countrySource = networkCountry(request, env.FORE_DEFAULT_TERRITORY || "US").source;
  const coalesce =
    env.COVE_SSR_STAGING === "1" &&
    env.COVE_THIN_METADATA_COALESCE === "1" &&
    // A/B control is available only inside the existing bearer-protected
    // synthetic benchmark Worker; it cannot disable rights checks or the
    // rate limiter and has no effect in a live customer deployment.
    request.headers.get("x-cove-perf-no-metadata-flight") !== "1" &&
    (request.headers.get("accept-language") || "").length <= 512;
  const flight = coalesce
    ? anonymousMetadataFlight(
        rawDb,
        JSON.stringify([
          trustedCountry,
          countrySource,
          env.FORE_DEFAULT_TERRITORY || "US",
          request.headers.get("accept-language") || "",
        ]),
        fetchContext,
      )
    : { task: fetchContext(), joined: false };
  const contextPromise = timed("context", flight.task);
  // The read-only metadata batch now also performs the active market/locale
  // lookup. No second dependent D1 service call is needed for anonymous SSR.
  const [context, , catalog] = await Promise.all([
    contextPromise,
    timed("limit", enforceFirstPaintRateLimit(env, `search:catalog:ip:${ip}`, 180)),
    // NULL currency means active-market currency is looked up in this SAME
    // live primary D1 statement with the full retail-grant view.
    timed(
      "catalog",
      reusePresentation
        ? liveRightsForAnonymousPresentationSeeds(
            env,
            trustedCountry,
            candidateSeed!.ids,
            d1Metrics,
          ).then((approved) => {
            const books = new Map(candidateSeed!.books.map((book) => [book.productId, book]));
            const results = approved.flatMap((row) => {
              const cached = books.get(row.productId);
              if (!cached) return [];
              // Retain only public presentation, but always take the current
              // primary-D1 offer and availability from this same fresh query.
              const offer = row.offerJson
                ? (JSON.parse(row.offerJson) as typeof cached.offer)
                : undefined;
              return [{ ...cached, offer }];
            });
            return {
              results,
              count: results.length,
              next: candidateSeed!.hasMore ? "/api/fore/catalog?page=2&sort=popular" : null,
              preview: true as const,
              search: {
                queryId: null,
                backend: "d1-fts5" as const,
                processingTimeMs: 0,
                pageSize: 24,
              },
            };
          })
        : firstPaintStorefrontShelf(env, null, trustedCountry, d1Metrics, candidateSeed?.ids),
    ),
  ]);
  if (seedEnabled) {
    if (!candidateSeed && catalog.results.length) {
      const ids = catalog.results
        .map((book) => String(book.productId || ""))
        .filter(Boolean)
        .slice(0, 60);
      if (ids.length) {
        seedBucket!.set(seedKey, {
          ids,
          books: catalog.results,
          hasMore: !!catalog.next,
          expiresAt: Date.now() + 30_000,
        });
      }
    } else if (candidateSeed?.hasMore && !catalog.next) {
      // A pre-ranked shortlist may not include page two. Keep its previously
      // observed presentation-only next-page hint, never rights information.
      catalog.next = "/api/fore/catalog?page=2&sort=popular";
    }
    if (env.COVE_SSR_DIAGNOSTICS === "1") timings.catalog_seeded = candidateSeed ? 1 : 0;
    if (env.COVE_SSR_DIAGNOSTICS === "1") timings.catalog_presentation_reused = reusePresentation ? 1 : 0;
  }
  if (context.rightsCountry !== trustedCountry)
    throw new Error("Anonymous country mismatch; refuse to render a legal-rights shelf.");
  // Only the presentation projection is combined. No entitlement data comes
  // from the market list, and the primary D1 rights query above must finish.
  const { availableMarkets, homepagePageRow, ...publicContext } = context;
  if (!Array.isArray(availableMarkets))
    throw new Error("Anonymous market projection is unavailable.");
  const page = formatGenericStorefrontPageRecord("/", homepagePageRow ?? null);
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
  // A sampled join marker alone is not an attribution denominator. Stage-only
  // responses must report both the eligible cohort and join outcome (0 or 1)
  // so one favorable colo cannot be mistaken for a coalescing improvement.
  if (env.COVE_SSR_STAGING === "1" && env.COVE_SSR_DIAGNOSTICS === "1") {
    timings.context_flight_eligible = coalesce ? 1 : 0;
    timings.context_joined = flight.joined ? 1 : 0;
  }
  if (d1Metrics.sqlDurationMs !== undefined) timings.catalog_sql = d1Metrics.sqlDurationMs;
  if (env.COVE_SSR_DIAGNOSTICS === "1" && contextMetrics.sqlDurationMs !== undefined)
    timings.context_sql = contextMetrics.sqlDurationMs;

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
