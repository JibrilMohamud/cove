import { networkCountry, resolveStorefrontContext, storefrontMarkets } from "./localization.server";
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
  // With no cookies or account identity, the canonical rightsCountry is
  // derived entirely from the trusted network. Use exactly that resolver
  // rather than an untrusted visitor header to start rights work immediately.
  const trustedCountry = networkCountry(request, env.FORE_DEFAULT_TERRITORY || "US").country;
  // All three checks plus the primary D1 legal read start together.
  // No preview leaves the Worker until all four have succeeded.
  const contextPromise = timed(
    "context",
    resolveStorefrontContext(readMetadata(), request, null, env.FORE_DEFAULT_TERRITORY || "US"),
  );
  // Page metadata needs the localized context, but no catalog or markets.
  // Chain it immediately onto context so the page read overlaps the primary
  // rights query even if the latter is temporarily queued.
  const pagePromise = contextPromise.then((context) =>
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
  );
  const [context, availableMarkets, catalog, page] = await Promise.all([
    contextPromise,
    timed("markets", storefrontMarkets(readMetadata())),
    timed("limit", enforceFirstPaintRateLimit(env, `search:catalog:ip:${ip}`, 180)).then(
      () => null,
    ),
    // The primary determines current default currency in this exact SQL
    // snapshot; presentation replicas never decide authorized book access.
    timed("catalog", firstPaintStorefrontShelf(env, null, trustedCountry)),
    pagePromise,
  ]).then(([resolved, markets, , firstPage, landing]) => [
    resolved,
    markets,
    firstPage,
    landing,
  ] as const);
  if (context.rightsCountry !== trustedCountry)
    throw new Error("Anonymous network rights mismatch; fail closed.");
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
        "Server-Timing": Object.entries(timings)
          .map(([name, ms]) => `cove_${name};dur=${ms.toFixed(1)}`)
          .join(", "),
      },
    },
  );
}
