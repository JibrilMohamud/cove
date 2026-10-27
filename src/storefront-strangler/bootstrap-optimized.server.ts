import {
  servePreparedCatalog,
  namespacedPresentationStore,
  type PrivatePresentationStore,
} from "./prepared-catalog.server";
import {
  readHomepagePresentation,
  authorizeHomepagePresentation,
} from "./homepage-presentation.server";
import { authorizeHomepageWithUnifiedOwner } from "./legal-authority-read.server";
import { hedgedPrivatePresentation } from "./presentation-hedge.server";
import type { FirstPaintD1QueryMetrics } from "../features/fore/catalog-model.server";
import { networkCountry, resolveAnonymousHomepageContext } from "./localization-optimized.server";
import { formatGenericStorefrontPageRecord } from "./page-record";
import { firstPaintStorefrontShelf } from "../features/fore/search.server";
import { enforceFirstPaintRateLimit } from "../features/fore/storefront-read-rate-limit.server";
import type { CoveEnv } from "../features/fore/api.server";
type OptimizedEnv = CoveEnv & {
  COVE_SSR_DIAGNOSTICS?: string;
  COVE_THIN_METADATA_COALESCE?: string;
  COVE_STRANGLER_READ_MODEL?: string;
  PRESENTATION?: PrivatePresentationStore;
  PRESENTATION_KV?: {
    get(key: string, options: { type: "text"; cacheTtl: number }): Promise<string | null>;
  };
  COVE_PRESENTATION_KV_ACCELERATE?: string;
  COVE_PRESENTATION_PREFIX?: string;
  COVE_STRANGLER_MODE?: string;
  COVE_STRANGLER_RELEASE_CERTIFIED?: string;
  // PRIVATE STAGING ONLY. This cannot be enabled by customer routing and is
  // intentionally excluded from the hosted primary-D1 release benchmark.
  COVE_LEGAL_OWNER_STAGE_READ_ENABLED?: string;
  COVE_LEGAL_OWNER_WRITER_CLOSURE_AUDITED?: string;
  // Owner-only reads are unsafe if ANY legacy positive legal writer can
  // bypass the same canonical write lock in the enrolled staging gateway.
  COVE_CANONICAL_LEGAL_WRITE_LOCK?: string;
  COVE_RIGHTS_OWNER_SECRET?: string;
  COVE_STRANGLER_DATABASE_ID?: string;
  LEGAL_AUTHORITY?: {
    getByName(name: string): { fetch(request: Request): Promise<Response> };
  };
};

// Preserve the exact serialized JSON from this freshly authorized bootstrap.
// The caller is in the SAME Worker isolate; consuming its own Response body
// asynchronously adds an unnecessary stream scheduling boundary at 100 RPS.
// Weak keys cannot outlive the internal response or authorize a new request.
const trustedBootstrapBodies = new WeakMap<Response, string>();
export function readTrustedLeanBootstrapJson(response: Response): string | undefined {
  return trustedBootstrapBodies.get(response);
}

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

// Stage-only KV holds UNTRUSTED presentation bytes. Rights, prices and
// entitlements always come from a fresh primary D1 statement. The wrapper is
// stable per binding so completed 30-second reuse still works per isolate.
const stageKvStore = new WeakMap<
  PrivatePresentationStore,
  {
    kv: NonNullable<OptimizedEnv["PRESENTATION_KV"]>;
    adapter: PrivatePresentationStore;
  }
>();
function stageAcceleratedPresentation(
  r2: PrivatePresentationStore,
  kv: NonNullable<OptimizedEnv["PRESENTATION_KV"]>,
): PrivatePresentationStore {
  const existing = stageKvStore.get(r2);
  if (existing?.kv === kv) return existing.adapter;
  const adapter = hedgedPrivatePresentation(r2, kv, {
    hedgeAfterMs: 45,
    // Display-only bytes are immutable, bounded to 2.5s per warm isolate.
    // Every response still awaits the independent current D1/owner decision.
    cacheForMs: 2500,
    onEvidence: (evidence) => {
      // No source URLs, book identities or secrets in provider diagnostics.
      if (
        evidence.hedged &&
        ((evidence.r2Ms ?? 0) > 140 || evidence.kvMs === null || evidence.kvMs > 140)
      )
        console.warn("cove_presentation_storage_hedge", evidence);
    },
  });
  stageKvStore.set(r2, { kv, adapter });
  return adapter;
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
  const d1Metrics: FirstPaintD1QueryMetrics = {};
  const contextMetrics: {
    sqlDurationMs?: number;
    rowsRead?: number;
    measuredStatements?: number;
  } = {};
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
  const model = env.COVE_STRANGLER_READ_MODEL;
  if (model !== undefined && !["0", "1", "2"].includes(model))
    throw Error("Unknown storefront read model");
  const kvStage = env.COVE_PRESENTATION_KV_ACCELERATE === "1";
  // The same presentation accelerator is available to the strictly certified
  // customer gateway, never to an arbitrary production or public Worker.
  // Display bytes are untrusted: primary D1 re-authorizes every response.
  const certifiedPublishedGateway =
    env.COVE_SSR_STAGING !== "1" &&
    env.COVE_STRANGLER_MODE === "customer-gateway" &&
    env.COVE_STRANGLER_RELEASE_CERTIFIED === "1" &&
    /^production\/[a-z0-9._-]+\/$/.test(env.COVE_PRESENTATION_PREFIX || "");
  if (
    kvStage &&
    (model !== "2" ||
      !env.PRESENTATION ||
      !env.PRESENTATION_KV ||
      (env.COVE_SSR_STAGING !== "1" && !certifiedPublishedGateway))
  )
    throw Error("Presentation accelerator requires certified KV/R2 v2 bindings");
  const presentationBinding =
    kvStage && env.PRESENTATION && env.PRESENTATION_KV
      ? stageAcceleratedPresentation(env.PRESENTATION, env.PRESENTATION_KV)
      : env.PRESENTATION;
  const stagedLegalOwnerRead = env.COVE_LEGAL_OWNER_STAGE_READ_ENABLED === "1";
  if (
    stagedLegalOwnerRead &&
    !(
      env.COVE_SSR_STAGING === "1" &&
      env.COVE_STRANGLER_MODE === "production-acceptance" &&
      env.COVE_STRANGLER_DATABASE_ID === "4bd657ac-8789-403e-a28c-93aba8d0a989" &&
      env.COVE_LEGAL_OWNER_WRITER_CLOSURE_AUDITED === "1" &&
      // A self-declared audit flag alone does not close raw canonical D1
      // mutation paths. Refuse the fast read unless the staged writer lock
      // is explicitly installed on the same deployment.
      env.COVE_CANONICAL_LEGAL_WRITE_LOCK === "1" &&
      typeof env.LEGAL_AUTHORITY?.getByName === "function" &&
      /^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET || "") &&
      model === "2"
    )
  )
    throw Error("Legal owner read not certified for protected staging");
  const presentationStore = presentationBinding
    ? namespacedPresentationStore(presentationBinding, env.COVE_PRESENTATION_PREFIX, model === "2")
    : undefined;
  if ((model === "1" || model === "2") && !env.PRESENTATION)
    throw Error("Private presentation binding required");
  // v2 loads locale/page presentation with candidates in one private R2 read.
  // It never performs the old metadata batch, speculative reads, or a global
  // catalog fallback. Rate admission starts concurrently with the R2 read.
  const projection =
    model === "2"
      ? timed("presentation", readHomepagePresentation(presentationStore!, request, trustedCountry))
      : null;
  const flight = projection
    ? { task: projection.then((p) => p.context), joined: false }
    : coalesce
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
  const admission = timed("limit", enforceFirstPaintRateLimit(env, `search:catalog:ip:${ip}`, 180));
  const [context, , catalog] = await Promise.all([
    timed("context", flight.task),
    admission,
    model === "2"
      ? Promise.all([projection!, admission]).then(([p]) =>
          timed(
            "catalog",
            stagedLegalOwnerRead
              ? authorizeHomepageWithUnifiedOwner(
                  env.LEGAL_AUTHORITY!.getByName("cove-staged-legal-global-v1"),
                  env.COVE_RIGHTS_OWNER_SECRET!,
                  p,
                )
              : authorizeHomepagePresentation(rawDb, p, d1Metrics),
          ),
        )
      : model === "1"
        ? timed(
            "catalog",
            servePreparedCatalog(rawDb, presentationStore!, trustedCountry, Date.now(), d1Metrics),
          )
        : timed("catalog", firstPaintStorefrontShelf(env, null, trustedCountry, d1Metrics)),
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
  }
  if (d1Metrics.sqlDurationMs !== undefined) timings.catalog_sql = d1Metrics.sqlDurationMs;
  if (env.COVE_SSR_DIAGNOSTICS === "1" && contextMetrics.sqlDurationMs !== undefined)
    timings.context_sql = contextMetrics.sqlDurationMs;

  timings.bootstrap = performance.now() - started;
  timings.lean = 0;
  const serialized = JSON.stringify({
    context: { ...publicContext, availableMarkets },
    page,
    catalog,
    catalogQuery: query,
    at: Date.now(),
  });
  const response = new Response(serialized, {
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
        ...(env.COVE_SSR_DIAGNOSTICS === "1" && d1Metrics.servedByRegion
          ? [`cove_catalog_region;desc="${d1Metrics.servedByRegion}"`]
          : []),
        ...(env.COVE_SSR_DIAGNOSTICS === "1" && d1Metrics.servedByPrimary !== undefined
          ? [`cove_catalog_primary;desc="${Number(d1Metrics.servedByPrimary)}"`]
          : []),
      ].join(", "),
    },
  });
  trustedBootstrapBodies.set(response, serialized);
  return response;
}
