import {
  networkCountry,
  resolveAnonymousHomepageContext,
} from "../features/fore/localization.server";
import { firstPaintStorefrontShelf } from "../features/fore/search.server";
import { enforceFirstPaintRateLimit } from "../features/fore/storefront-read-rate-limit.server";
import type { CoveEnv } from "../features/fore/api.server";
import { loadThinPresentationContext } from "./presentation-cache";

type DiagnosticEnv = CoveEnv & {
  COVE_SSR_STAGING?: string;
  COVE_THIN_STOREFRONT?: string;
  COVE_THIN_METADATA_CACHE?: string;
  COVE_PERF_DATABASE_ID?: string;
};

export const thinDiagnosticRoutes = new Set([
  "/__cove_perf/edge",
  "/__cove_perf/context-uncached",
  "/__cove_perf/context-cached",
  "/__cove_perf/rights",
]);

/**
 * Every probe is bearer-authenticated by the enclosing Worker and bound to
 * the exact synthetic 50k D1. A probe is NOT an offer or storefront response.
 * Public production traffic must never be able to call these paths.
 */
export async function runThinDiagnostic(
  request: Request,
  env: DiagnosticEnv,
  route: string,
): Promise<Response> {
  if (
    request.method !== "GET" ||
    !thinDiagnosticRoutes.has(route) ||
    env.COVE_SSR_STAGING !== "1" ||
    env.COVE_THIN_STOREFRONT !== "synthetic-only" ||
    env.COVE_PERF_DATABASE_ID !== "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3"
  )
    return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });

  const started = performance.now();
  const country = networkCountry(request, env.FORE_DEFAULT_TERRITORY || "US").country;
  if (country !== request.headers.get("x-cove-client-country"))
    return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });

  let books: number | undefined;
  let markets: number | undefined;
  let sqlMs: number | undefined;
  const stage = route.split("/").at(-1)!;
  if (stage !== "edge") {
    const ip = request.headers.get("cf-connecting-ip")?.trim();
    if (!ip) return new Response(null, { status: 503 });
    // Diagnostic probes have the same limiter and independent client key as
    // the live shelf, even though only the rights probe reads legal offers.
    await enforceFirstPaintRateLimit(env, `search:catalog:ip:${ip}`, 180);
  }
  if (stage === "rights") {
    const metrics: { sqlDurationMs?: number } = {};
    const catalog = await firstPaintStorefrontShelf(env, null, country, metrics);
    books = catalog.results.length;
    sqlMs = metrics.sqlDurationMs;
    if (!books) throw new Error("Rights probe has an empty synthetic shelf");
  } else if (stage === "context-cached" || stage === "context-uncached") {
    const rawDb = env.DB!;
    const db = rawDb as typeof rawDb & {
      withSession?: (constraint: "first-unconstrained") => typeof rawDb;
    };
    const read = () =>
      resolveAnonymousHomepageContext(
        typeof db.withSession === "function" ? db.withSession("first-unconstrained") : rawDb,
        request,
        env.FORE_DEFAULT_TERRITORY || "US",
      );
    const context =
      stage === "context-cached"
        ? await loadThinPresentationContext(request, env, read)
        : await read();
    if (context.rightsCountry !== country || !Array.isArray(context.availableMarkets))
      throw new Error("Presentation probe country mismatch or no active markets");
    markets = context.availableMarkets.length;
  }
  const elapsed = performance.now() - started;
  return new Response(
    JSON.stringify({
      stage,
      ok: true,
      ...(books === undefined ? {} : { books }),
      ...(markets === undefined ? {} : { markets }),
    }),
    {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "server-timing": [
          `cove_diagnostic;dur=${elapsed.toFixed(1)}`,
          ...(sqlMs === undefined ? [] : [`cove_catalog_sql;dur=${sqlMs.toFixed(1)}`]),
        ].join(", "),
      },
    },
  );
}
