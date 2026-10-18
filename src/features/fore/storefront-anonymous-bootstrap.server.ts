import { resolveStorefrontContext, storefrontMarkets } from "./localization.server";
import { resolveStorefrontPage } from "./taxonomy.server";
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
  // Exactly the canonical search:catalog:ip:<cf-connecting-ip> limiter key.
  const [context, availableMarkets] = await Promise.all([
    timed(
      "context",
      resolveStorefrontContext(readMetadata(), request, null, env.FORE_DEFAULT_TERRITORY || "US"),
    ),
    timed("markets", storefrontMarkets(readMetadata())),
    timed("limit", enforceFirstPaintRateLimit(env, `search:catalog:ip:${ip}`, 180)),
  ]);
  const query = new URLSearchParams({
    search: "",
    sort: "popular",
    page: "1",
    currency: context.currency,
  }).toString();
  const d1Metrics: { sqlDurationMs?: number; rowsRead?: number; attempts?: number } = {};
  const [page, catalog] = await Promise.all([
    timed(
      "page",
      resolveStorefrontPage(
        readMetadata(),
        "/",
        context.rightsCountry,
        context.language,
        context.locale,
      ),
    ),
    // IMPORTANT: no replica/session here. Legal filtering stays in the
    // original D1 binding, enforcing revocations on every SSR request.
    timed("catalog", firstPaintStorefrontShelf(env, context.currency, context.rightsCountry, d1Metrics)),
  ]);
  // Numbers only; a slow catalog SQL phase vs a slow D1 service/transport
  // round trip can now be distinguished without logging rights details.
  if (d1Metrics.sqlDurationMs !== undefined) timings.catalog_sql = d1Metrics.sqlDurationMs;

  timings.bootstrap = performance.now() - started;
  timings.lean = 0;
  return new Response(
    JSON.stringify({
      context: { ...context, availableMarkets },
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
