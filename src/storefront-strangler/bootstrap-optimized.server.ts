import { networkCountry, resolveAnonymousHomepageContext } from "./localization-optimized.server";
import { formatGenericStorefrontPageRecord } from "./page-record";
import { firstPaintStorefrontShelf } from "../features/fore/search.server";
import { enforceFirstPaintRateLimit } from "../features/fore/storefront-read-rate-limit.server";
import type { CoveEnv } from "../features/fore/api.server";
type OptimizedEnv = CoveEnv & {
  COVE_SSR_DIAGNOSTICS?: string;
  COVE_THIN_METADATA_COALESCE?: string;
  COVE_THIN_METADATA_HEDGE?: string;
  COVE_THIN_PRIMARY_MICROBATCH?: string;
  COVE_STRANGLER_DATABASE_ID?: string;
  COVE_STRANGLER_MODE?: string;
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
// Rights decisions are never cached, even for one millisecond. A 64-ms
// admission window groups only requests that arrived BEFORE primary D1's
// authoritative SELECT begins. After admission closes the flight is removed
// immediately, so later arrivals must initiate a fresh legal check.
// This experimental path is strictly limited to the synthetic stage database.
type FirstPaintShelf = Awaited<ReturnType<typeof firstPaintStorefrontShelf>>;
const pendingPreReadShelves = new WeakMap<object, Map<string, Promise<FirstPaintShelf>>>();
function preReadPrimaryBatch(
  binding: object,
  country: string,
  create: () => Promise<FirstPaintShelf>,
): { task: Promise<FirstPaintShelf>; joined: boolean } {
  let flights = pendingPreReadShelves.get(binding);
  if (!flights) {
    flights = new Map();
    pendingPreReadShelves.set(binding, flights);
  }
  const existing = flights.get(country);
  if (existing) return { task: existing, joined: true };
  const task = new Promise<FirstPaintShelf>((resolve, reject) => {
    setTimeout(() => {
      // Do not admit requests after the primary check has begun.
      if (flights!.get(country) === task) flights!.delete(country);
      Promise.resolve().then(create).then(resolve, reject);
    }, 64);
  });
  flights.set(country, task);
  return { task, joined: false };
}
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
  // Launch the authoritative primary-rights query *before* waiting for
  // independent replica presentation reads. No book leaves the Worker until
  // the rate limiter, markets, context, page and rights checks ALL succeed.
  // A cold D1 read replica can occasionally spend seconds in service wait
  // even though the four market/locale SQL statements take <10 ms. After a
  // bounded 200 ms delay, hedge PRESENTATION ONLY against direct primary D1.
  // Neither attempt can select legal product IDs or authorize a purchase.
  // Keep the experiment disabled for every customer-facing gateway.
  const hedgeEligible =
    env.COVE_SSR_STAGING === "1" &&
    env.COVE_THIN_METADATA_HEDGE === "1" &&
    typeof configDb.withSession === "function" &&
    (env.COVE_STRANGLER_DATABASE_ID === "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3" ||
      (env.COVE_STRANGLER_MODE === "production-acceptance" &&
        env.COVE_STRANGLER_DATABASE_ID === "4bd657ac-8789-403e-a28c-93aba8d0a989"));
  let hedgeStarted = false;
  let hedgeWon = false;
  const fetchContext = () => {
    const query = (db: typeof rawDb, metrics: typeof contextMetrics) =>
      resolveAnonymousHomepageContext(db, request, env.FORE_DEFAULT_TERRITORY || "US", metrics);
    if (!hedgeEligible) return query(readMetadata(), contextMetrics);
    const replicaMetrics: typeof contextMetrics = {};
    const primaryMetrics: typeof contextMetrics = {};
    const replica = query(readMetadata(), replicaMetrics).then((context) => ({
      context,
      metrics: replicaMetrics,
      primary: false,
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const primary = new Promise<Awaited<typeof replica>>((resolve) => {
      timer = setTimeout(() => {
        hedgeStarted = true;
        resolve(
          query(rawDb, primaryMetrics).then((context) => ({
            context,
            metrics: primaryMetrics,
            primary: true,
          })),
        );
      }, 200);
    });
    return Promise.any([replica, primary])
      .then(({ context, metrics, primary }) => {
        Object.assign(contextMetrics, metrics);
        hedgeWon = primary;
        return context;
      })
      .finally(() => clearTimeout(timer));
  };
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
  // Allow a real-data experiment only behind the existing bearer-gated,
  // read-only production-acceptance preview. Never activate for customers:
  // they still use a fresh rights SELECT for every individual request.
  const microbatchAllowedDatabase =
    env.COVE_STRANGLER_DATABASE_ID === "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3" ||
    (env.COVE_STRANGLER_MODE === "production-acceptance" &&
      env.COVE_STRANGLER_DATABASE_ID === "4bd657ac-8789-403e-a28c-93aba8d0a989");
  const microbatchEnabled =
    env.COVE_SSR_STAGING === "1" &&
    microbatchAllowedDatabase &&
    env.COVE_THIN_PRIMARY_MICROBATCH === "1";
  const createShelf = () => firstPaintStorefrontShelf(env, null, trustedCountry, d1Metrics);
  const shelfFlight = microbatchEnabled
    ? preReadPrimaryBatch(rawDb, trustedCountry, createShelf)
    : { task: createShelf(), joined: false };
  const [context, , catalog] = await Promise.all([
    contextPromise,
    timed("limit", enforceFirstPaintRateLimit(env, `search:catalog:ip:${ip}`, 180)),
    // NULL currency means active-market currency is looked up in this SAME
    // live primary D1 statement with the full retail-grant view.
    timed("catalog", shelfFlight.task),
  ]);
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
    timings.metadata_hedge_eligible = hedgeEligible ? 1 : 0;
    timings.metadata_hedge_started = hedgeStarted ? 1 : 0;
    timings.metadata_hedge_won = hedgeWon ? 1 : 0;
    timings.primary_microbatch_eligible = microbatchEnabled ? 1 : 0;
    timings.primary_microbatch_joined = shelfFlight.joined ? 1 : 0;
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
