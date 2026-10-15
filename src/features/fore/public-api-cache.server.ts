import type { CoveEnv } from "./api.server";
import { rateLimitSearchRequest } from "./api.server";
import { ApiError, json } from "./service";
import { recordCachedSearchQuery, cachedCatalogPageAllowed } from "./search.server";
import { writeCatalogCache } from "./catalog-cache.server";

type Context = { waitUntil?: (work: Promise<unknown>) => void };
type Handler = (request: Request, env: CoveEnv) => Promise<Response | null>;
const PREFIX = "public-api:v2:";
const MAX_BYTES = 256 * 1024;

export function publicCacheTtl(path: string) {
  if (path === "/api/fore/service-status") return 30;
  if (path === "/api/fore/catalog") return 300;
  // Guest-only, market-partitioned initial HTML data. Avoid the repeated multi-query D1 bootstrap.
  if (path === "/api/fore/storefront/bootstrap") return 60;
  if (path === "/api/fore/taxonomy") return 1800;
  if (path === "/api/fore/storefront/page") return 900;
  if (path === "/api/fore/search/suggest") return 60;
  if (path === "/api/fore/audiobooks" || /^\/api\/fore\/audio\/[^/]+$/.test(path)) return 300;
  if (/^\/api\/fore\/books\/[^/]+(?:\/detail)?$/.test(path)) return 60;
  return 0;
}
export function publicCacheKey(request: Request, fallbackCountry = "US") {
  const url = new URL(request.url);
  const rawCountry = (
    request.headers.get("x-cove-client-country") ||
    request.headers.get("cf-ipcountry") ||
    fallbackCountry
  )
    .trim()
    .toUpperCase();
  const country =
    /^[A-Z]{2}$/.test(rawCountry) && !["XX", "T1", "ZZ"].includes(rawCountry)
      ? rawCountry
      : fallbackCountry;
  url.searchParams.set("__cove_country", country);
  // Locale selection uses the complete quality-weighted header, including fallbacks.
  url.searchParams.set(
    "__cove_language",
    (request.headers.get("accept-language") || "").trim().toLowerCase(),
  );
  url.searchParams.set("__cove_cache_version", "3");
  // Guest storefront preferences are safe variants, not authentication.
  url.searchParams.set(
    "__cove_preferences",
    (request.headers.get("cookie") || "")
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean)
      .sort()
      .join("; "),
  );
  url.searchParams.sort();
  return new Request(url.toString());
}
export function publicCacheEligible(request: Request) {
  const cookies = (request.headers.get("cookie") || "")
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
  const safeCookies = cookies.every((value) =>
    /^(fore-storefront-country|fore-locale|fore-currency)=.{0,100}$/.test(value),
  );
  return (
    request.method === "GET" &&
    safeCookies &&
    !["authorization", "oai-authenticated-user-id", "range"].some((name) =>
      request.headers.has(name),
    ) &&
    publicCacheTtl(new URL(request.url).pathname) > 0
  );
}
function decorate(response: Response, state: "HIT" | "MISS" | "BYPASS", freshReference = false) {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-cove-backend-cache", state);
  headers.set("x-cove-persistence", "d1-r2");
  if (freshReference) {
    headers.set("x-fore-request-id", `req_${crypto.randomUUID()}`);
    headers.delete("traceparent");
    headers.delete("x-fore-trace-id");
  }
  return new Response(response.body, { status: response.status, headers });
}
async function boundedJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } finally {
    reader.releaseLock();
  }
}

/** A bounded shared application cache also works where edge Cache API is unavailable. */
export async function cachedPublicApi(
  request: Request,
  cacheRequest: Request,
  env: CoveEnv,
  ctx: Context,
  handler: Handler,
) {
  if (!publicCacheEligible(request)) {
    const response = await handler(request, env);
    return response ? decorate(response, "BYPASS") : null;
  }
  const path = new URL(request.url).pathname;
  const key = publicCacheKey(cacheRequest, env.FORE_DEFAULT_TERRITORY || "US");
  const digest = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key.url))),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const dbKey = PREFIX + digest;
  const edge = (globalThis as typeof globalThis & { caches?: { default?: Cache } }).caches?.default;
  let useDb = !edge || new URL(cacheRequest.url).hostname.endsWith(".workers.dev");
  let hit: Response | undefined;
  if (edge && !useDb) {
    try {
      hit = await edge.match(key);
    } catch (error) {
      console.warn("Edge cache read unavailable", error);
      useDb = true;
    }
  }
  if (useDb) {
    try {
      const row = await env.DB.prepare("SELECT body FROM api_cache WHERE key=? AND expires_at>?")
        .bind(dbKey, Date.now())
        .first<{ body: string }>();
      if (row)
        hit = new Response(row.body, {
          headers: { "content-type": "application/json; charset=utf-8" },
        });
    } catch (error) {
      console.warn("Public cache read unavailable", error);
    }
  }
  if (hit) {
    if (
      path === "/api/fore/catalog" ||
      path === "/api/fore/storefront/bootstrap" ||
      path === "/api/fore/search/suggest"
    ) {
      try {
        await rateLimitSearchRequest(
          request,
          env,
          null,
          path.endsWith("suggest") ? "suggest" : "catalog",
          path.endsWith("suggest") ? 240 : 180,
        );
      } catch (error) {
        if (error instanceof ApiError)
          return decorate(json({ error: error.message }, error.status), "BYPASS");
        throw error;
      }
    }
    try {
      const data = await boundedJson(hit);
      if (data) {
        if (path === "/api/fore/storefront/bootstrap") {
          const context = data.context as { rightsCountry?: unknown } | undefined;
          const catalog = data.catalog as
            | {
                results?: unknown[];
                count?: unknown;
                search?: {
                  backend?: unknown;
                  correctedQuery?: string | null;
                  [key: string]: unknown;
                };
              }
            | undefined;
          if (
            typeof context?.rightsCountry !== "string" ||
            !/^[A-Z]{2}$/.test(context.rightsCountry) ||
            typeof data.catalogQuery !== "string" ||
            !Array.isArray(catalog?.results) ||
            typeof catalog.count !== "number" ||
            typeof catalog.search?.backend !== "string"
          )
            throw new Error("Invalid cached storefront bootstrap.");
          const results = catalog.results.filter((book: unknown): book is { productId: string } =>
            Boolean(
              book &&
                typeof book === "object" &&
                "productId" in book &&
                typeof book.productId === "string",
            ),
          );
          if (results.length !== catalog.results.length)
            throw new Error("Malformed cached storefront products.");
          const catalogUrl = new URL(`/api/fore/catalog?${data.catalogQuery}`, request.url);
          // The cache is not a rights authority: re-check every edition against
          // current territory, publication and suppression rules on each HIT.
          if (
            !(await cachedCatalogPageAllowed(
              env,
              catalogUrl,
              results.map((book) => book.productId),
              context.rightsCountry,
            ))
          )
            throw new Error("Cached storefront rights changed.");
          const queryId = await recordCachedSearchQuery(
            env,
            catalogUrl,
            {
              results,
              count: catalog.count,
              search: {
                backend: catalog.search.backend,
                correctedQuery: catalog.search.correctedQuery,
                queryId: null,
              },
            },
            context.rightsCountry,
          ).catch((error: unknown) => {
            console.warn("Cached storefront analytics unavailable", error);
            return null;
          });
          catalog.search = { ...catalog.search, queryId, processingTimeMs: 0 };
          return decorate(Response.json(data), "HIT", true);
        }
        if (
          path === "/api/fore/catalog" &&
          Array.isArray(data.results) &&
          data.search &&
          typeof data.search === "object"
        ) {
          const search = data.search;
          if (
            !("backend" in search) ||
            typeof search.backend !== "string" ||
            typeof data.count !== "number"
          )
            throw new Error("Invalid cached search projection.");
          const results = data.results.filter((book: unknown): book is { productId: string } =>
            Boolean(
              book &&
              typeof book === "object" &&
              "productId" in book &&
              typeof book.productId === "string",
            ),
          );
          if (
            !(await cachedCatalogPageAllowed(
              env,
              new URL(request.url),
              results.map((book) => book.productId),
              new URL(key.url).searchParams.get("__cove_country") || "US",
            ))
          )
            throw new Error("Cached catalog eligibility changed");
          const cached = {
            results,
            count: data.count,
            search: {
              backend: search.backend,
              correctedQuery:
                "correctedQuery" in search && typeof search.correctedQuery === "string"
                  ? search.correctedQuery
                  : null,
              queryId: null,
            },
          };
          const queryId = await recordCachedSearchQuery(
            env,
            new URL(request.url),
            cached,
            new URL(key.url).searchParams.get("__cove_country") || "US",
          ).catch((error: unknown) => {
            console.warn("Cached search analytics unavailable", error);
            return null;
          });
          data.search = { ...search, queryId, processingTimeMs: 0 };
          return decorate(Response.json(data), "HIT", true);
        }
        return decorate(Response.json(data), "HIT", true);
      }
    } catch (error) {
      console.warn("Invalid public cache entry", error);
    }
  }
  const response = await handler(request, env);
  if (!response) return null;
  if (
    response.status !== 200 ||
    response.headers.has("set-cookie") ||
    !response.headers.get("content-type")?.includes("application/json") ||
    /\bprivate\b/i.test(response.headers.get("cache-control") || "")
  )
    return decorate(response, "MISS");
  const write = async () => {
    const data = await boundedJson(response.clone());
    if (!data) return;
    // A query UUID and request diagnostics belong to one request, never the shared cache.
    if (data.search && typeof data.search === "object" && "queryId" in data.search)
      data.search.queryId = null;
    if (
      path === "/api/fore/storefront/bootstrap" &&
      data.catalog &&
      typeof data.catalog === "object"
    ) {
      const nested = (data.catalog as Record<string, unknown>).search;
      if (nested && typeof nested === "object" && "queryId" in nested) nested.queryId = null;
    }
    const body = JSON.stringify(data);
    const ttl = publicCacheTtl(path);
    if (useDb) await writeCatalogCache(env.DB, dbKey, body, Date.now() + ttl * 1000, PREFIX, 128);
    else if (edge)
      await edge.put(
        key,
        new Response(body, {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": `public, max-age=${ttl}`,
          },
        }),
      );
  };
  const work = write().catch((error: unknown) =>
    console.warn("Public cache write unavailable", error),
  );
  if (ctx.waitUntil) ctx.waitUntil(work);
  else await work;
  return decorate(response, "MISS");
}

export async function prunePublicCache(env: CoveEnv) {
  return env.DB.prepare(
    "DELETE FROM api_cache WHERE key IN (SELECT key FROM api_cache WHERE expires_at<=? AND (key LIKE 'public-api:v2:%' OR key LIKE 'search-facets:v1:%' OR key LIKE 'search-page:v1:%') LIMIT 512)",
  )
    .bind(Date.now())
    .run();
}
