import type { CoveEnv } from "./api.server";
import { ApiError, json } from "./service";
import {
  networkCountry,
  resolveStorefrontContext,
  resolveAnonymousStorefrontContext,
} from "./localization.server";
import { parseSearchInput, searchCatalog } from "./search.server";
import { enforceFirstPaintRateLimit } from "./storefront-read-rate-limit.server";

/**
 * STAGING-ONLY anonymous browse path, preserving the full catalog response
 * shape and per-request rights validation. Never used for checkout, search
 * filters, authenticated users or production until measured and reviewed.
 */
export function canUseLeanAnonymousCatalog(request: Request, env: CoveEnv): boolean {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.pathname !== "/api/fore/catalog") return false;
  if (env.COVE_SSR_STAGING !== "1" || env.FORE_ENVIRONMENT !== "staging") return false;
  for (const key of [
    "authorization",
    "cookie",
    "oai-authenticated-user-id",
    "oai-authenticated-user-email",
    "x-fore-authenticated-user-id",
    "x-fore-authenticated-user-email",
  ])
    if (request.headers.has(key)) return false;
  if (
    !/^[A-Z]{2}$/.test(request.headers.get("x-cove-client-country") || "") ||
    !request.headers.get("cf-connecting-ip")?.trim()
  )
    return false;
  if (
    !env.DB ||
    typeof env.DB.prepare !== "function" ||
    typeof env.COVE_STOREFRONT_READ_LIMITER?.limit !== "function"
  )
    return false;
  const allowed = new Set(["search", "sort", "page", "currency"]);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) return false;
  if (
    (url.searchParams.get("search") || "") !== "" ||
    (url.searchParams.get("sort") || "popular") !== "popular" ||
    (url.searchParams.get("page") || "1") !== "1"
  )
    return false;
  // Do not accept conflicting parameters, even if the URL API picks one.
  if ([...allowed].some((key) => url.searchParams.getAll(key).length > 1)) return false;
  return true;
}

async function readLeanAnonymousCatalog(request: Request, env: CoveEnv) {
  if (!canUseLeanAnonymousCatalog(request, env))
    return new Response(null, { status: 403, headers: { "Cache-Control": "no-store" } });
  const started = performance.now();
  const url = new URL(request.url);
  const territory = networkCountry(request, env.FORE_DEFAULT_TERRITORY || "US").country;
  const ip = request.headers.get("cf-connecting-ip")!.trim();
  await enforceFirstPaintRateLimit(env, `search:catalog:ip:${ip}`, 180);
  const input = { ...parseSearchInput(url), territory };
  const startedContext = performance.now();
  let contextMs = 0;
  const resolveContext = async () => {
    try {
      return (env as CoveEnv & { FORE_ANON_CONTEXT_ONE_READ?: string })
        .FORE_ANON_CONTEXT_ONE_READ === "1"
        ? await resolveAnonymousStorefrontContext(env.DB, request, territory)
        : await resolveStorefrontContext(env.DB, request, null, territory);
    } finally {
      contextMs = performance.now() - startedContext;
    }
  };
  // Public configuration, live rights-scoped search and operation metadata
  // are independent. Await ALL of them before releasing any catalog data.
  const readState = async () =>
    env.DB.prepare(
      "SELECT status,page,last_success_at,total_catalog_count FROM catalog_state WHERE id=1",
    ).first<{
      status: string;
      page: number;
      last_success_at: string | null;
      total_catalog_count: number;
    }>();
  const [market, catalog, state] = await Promise.all([
    resolveContext(),
    searchCatalog(env, input, null),
    readState(),
  ]);
  if (market.rightsCountry !== territory)
    throw new Error("Catalog market and trusted territory disagree.");
  const next =
    input.page * catalog.limit < catalog.count
      ? (() => {
          const params = new URLSearchParams(url.searchParams);
          params.set("page", String(input.page + 1));
          return "/api/fore/catalog?" + params.toString();
        })()
      : null;
  return new Response(
    JSON.stringify({
      results: catalog.books,
      count: catalog.count,
      next,
      cached: true,
      facets: catalog.facets,
      search: {
        queryId: catalog.queryId,
        backend: catalog.backend,
        processingTimeMs: catalog.processingTimeMs,
        correctedQuery: catalog.correctedQuery || null,
        pageSize: catalog.limit,
      },
      ingestion: {
        status: state?.status || "idle",
        page: state?.page || 1,
        lastSuccessAt: state?.last_success_at || null,
        totalCatalogCount: state?.total_catalog_count || 0,
      },
    }),
    {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Server-Timing": `cove_lean_catalog;dur=${(performance.now() - started).toFixed(1)}, cove_catalog_context;dur=${contextMs.toFixed(1)}`,
      },
    },
  );
}

export async function serveLeanAnonymousCatalog(request: Request, env: CoveEnv) {
  try {
    return await readLeanAnonymousCatalog(request, env);
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    console.error("Anonymous catalog search failed closed", error);
    return json(
      { error: "The catalog is temporarily unavailable while Cove verifies distribution rights." },
      503,
    );
  }
}
