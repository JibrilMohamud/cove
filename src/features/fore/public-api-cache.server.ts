import type { CoveEnv } from "./api.server";
import { rateLimitSearchRequest } from "./api.server";
import { ApiError, json } from "./service";
import { recordCachedSearchQuery } from "./search.server";

type Context = { waitUntil?: (work: Promise<unknown>) => void };
type Handler = (request: Request, env: CoveEnv) => Promise<Response | null>;
const PREFIX = "public-api:v2:";
const MAX_BYTES = 256 * 1024;

export function publicCacheTtl(path: string) {
  if (path === "/api/fore/service-status") return 30;
  if (path === "/api/fore/catalog") return 90;
  if (path === "/api/fore/taxonomy") return 300;
  if (path === "/api/fore/storefront/page") return 300;
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
  url.searchParams.set("__cove_cache_version", "2");
  url.searchParams.sort();
  return new Request(url.toString());
}
export function publicCacheEligible(request: Request) {
  return (
    request.method === "GET" &&
    !["authorization", "cookie", "oai-authenticated-user-id", "range"].some((name) =>
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
    if (path === "/api/fore/catalog" || path === "/api/fore/search/suggest") {
      try {
        await rateLimitSearchRequest(
          request,
          env,
          null,
          path.endsWith("catalog") ? "catalog" : "suggest",
          path.endsWith("catalog") ? 180 : 240,
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
    const body = JSON.stringify(data);
    const ttl = publicCacheTtl(path);
    if (useDb)
      await env.DB.prepare(
        "INSERT INTO api_cache(key,body,expires_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM api_cache WHERE key=?) OR (SELECT count(*) FROM api_cache WHERE key>='public-api:v2:' AND key<'public-api:v3:')<128 ON CONFLICT(key) DO UPDATE SET body=excluded.body,expires_at=excluded.expires_at",
      )
        .bind(dbKey, body, Date.now() + ttl * 1000, dbKey)
        .run();
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
    "DELETE FROM api_cache WHERE key IN (SELECT key FROM api_cache WHERE expires_at<=? AND (key LIKE 'public-api:v2:%' OR key LIKE 'search-facets:v1:%') LIMIT 300)",
  )
    .bind(Date.now())
    .run();
}
