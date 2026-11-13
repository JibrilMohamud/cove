/**
 * Request-local, staging-only in-flight deduplication of the exact anonymous
 * market/locale/translation SELECT. This is PUBLIC presentation metadata.
 * No legal rights, grants, offers, entitlements or catalog rows are shared.
 *
 * Only calls made through the SAME request-owned wrapper may join. Never
 * share a promise between Worker invocations: ending the originating request
 * cancels its I/O and can leave other visitors waiting until their deadline.
 * Completed reads are removed immediately and NEVER cached. The independent
 * authoritative D1 retail-availability query still runs for each request.
 */
type MarketFlight = { startedAt: number; promise: Promise<unknown> };
const MAX_FLIGHTS_PER_BINDING = 8;
const MAX_JOIN_AGE_MS = 300;

export function safeMarketKey(sql: string, parameters: unknown[]): string | null {
  // Match the one source-verified localization query, not a general SQL API.
  if (
    !sql.includes("active_market AS MATERIALIZED") ||
    !sql.includes("chosen_locale AS MATERIALIZED") ||
    !sql.includes("FROM active_market m LEFT JOIN chosen_locale l") ||
    parameters.length !== 2
  )
    return null;
  const [country, encodedLocales] = parameters;
  if (typeof country !== "string" || !/^[A-Z]{2}$/.test(country)) return null;
  if (typeof encodedLocales !== "string" || encodedLocales.length > 200) return null;
  let locales: unknown;
  try {
    locales = JSON.parse(encodedLocales);
  } catch {
    return null;
  }
  if (
    !Array.isArray(locales) ||
    locales.length > 10 ||
    locales.some(
      (locale) =>
        typeof locale !== "string" ||
        locale.length > 24 ||
        !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(locale),
    )
  )
    return null;
  return country + ":" + JSON.stringify(locales);
}

function coalesceMarketRead<T>(
  active: Map<string, MarketFlight>,
  sql: string,
  parameters: unknown[],
  read: () => Promise<T>,
  onJoined?: () => void,
): Promise<T> {
  const key = safeMarketKey(sql, parameters);
  if (key === null) return read();
  const previous = active.get(key);
  const now = Date.now();
  if (previous && now - previous.startedAt <= MAX_JOIN_AGE_MS) {
    onJoined?.();
    return previous.promise as Promise<T>;
  }
  if (active.size >= MAX_FLIGHTS_PER_BINDING && !previous) return read();
  const promise = Promise.resolve().then(read);
  active.set(key, { startedAt: now, promise });
  const clear = () => {
    if (active?.get(key)?.promise === promise) active.delete(key);
  };
  // Both outcomes evict immediately; no unhandled rejection and no replay.
  void promise.then(clear, clear);
  return promise;
}

/**
 * Proxy only the exact market SELECT's all() invocation. Every other method,
 * query and fallback uses the same raw D1 binding without any interception.
 * Each wrapper owns its bounded map. Callers must create it inside their
 * request, never retain it in module state. The DB binding itself is unchanged.
 */
type PublicMetadataDatabase = {
  prepare: (sql: string) => {
    bind: (...args: unknown[]) => {
      all: () => Promise<unknown>;
    };
  };
};

export function withInFlightAnonymousMarketReads<T extends object>(
  db: T,
  onJoined?: () => void,
): T {
  const active = new Map<string, MarketFlight>();
  return new Proxy(db, {
    get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const statement = (target as PublicMetadataDatabase).prepare(sql);
        if (!sql.includes("active_market AS MATERIALIZED")) return statement;
        return new Proxy(statement, {
          get(prepared, method) {
            if (method !== "bind") {
              const value = Reflect.get(prepared, method, prepared);
              return typeof value === "function" ? value.bind(prepared) : value;
            }
            return (...parameters: unknown[]) => {
              const bound = prepared.bind(...parameters);
              if (!safeMarketKey(sql, parameters)) return bound;
              return new Proxy(bound, {
                get(query, operation) {
                  if (operation === "all")
                    return () =>
                      coalesceMarketRead(active, sql, parameters, () => query.all(), onJoined);
                  const value = Reflect.get(query, operation, query);
                  return typeof value === "function" ? value.bind(query) : value;
                },
              });
            };
          },
        });
      };
    },
  });
}

/**
 * STAGING ONLY: reuse completed public locale/market/translation/page data
 * for at most two seconds from read start. This reduces repeated primary-D1
 * metadata work under sustained load. Every visitor still executes fresh
 * primary-D1 territorial retail rights, availability and pricing queries.
 *
 * An in-flight D1 read, promise, Response, D1 statement or user identity is
 * NEVER stored across requests. Cache hits are deeply copied; a cold miss,
 * malformed/oversized result, failed read or expired entry invokes D1.
 * This public presentation optimization is not a legal authority or a
 * production rollout. Callers must enforce anonymous identity first.
 */
type CompletedMarketEntry = { body: string; bytes: number; until: number };
type CompletedMarketCache = { entries: Map<string, CompletedMarketEntry>; bytes: number };
const completedMarketByD1 = new WeakMap<object, CompletedMarketCache>();
const MARKET_COMPLETED_TTL_MS = 2_000;
const MARKET_COMPLETED_MAX_ITEMS = 32;
const MARKET_COMPLETED_MAX_BYTES = 1024 * 1024;
const MARKET_COMPLETED_MAX_ITEM_BYTES = 128 * 1024;

function liveMarketCache(scope: object, now: number): CompletedMarketCache {
  let cache = completedMarketByD1.get(scope);
  if (!cache) {
    cache = { entries: new Map(), bytes: 0 };
    completedMarketByD1.set(scope, cache);
  }
  for (const [key, entry] of cache.entries)
    if (entry.until <= now) {
      cache.entries.delete(key);
      cache.bytes -= entry.bytes;
    }
  return cache;
}

export function withCompletedAnonymousMarketReads<T extends object>(
  db: T,
  bindingScope: object,
  onHit?: () => void,
): T {
  return new Proxy(db, {
    get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const prepared = (target as PublicMetadataDatabase).prepare(sql);
        if (!sql.includes("active_market AS MATERIALIZED")) return prepared;
        return new Proxy(prepared, {
          get(statement, method) {
            if (method !== "bind") {
              const value = Reflect.get(statement, method, statement);
              return typeof value === "function" ? value.bind(statement) : value;
            }
            return (...parameters: unknown[]) => {
              const bound = statement.bind(...parameters);
              const key = safeMarketKey(sql, parameters);
              if (!key) return bound;
              return new Proxy(bound, {
                get(query, operation) {
                  if (operation !== "all") {
                    const value = Reflect.get(query, operation, query);
                    return typeof value === "function" ? value.bind(query) : value;
                  }
                  return async () => {
                    const startedAt = Date.now();
                    const cache = liveMarketCache(bindingScope, startedAt);
                    const hit = cache.entries.get(key);
                    if (hit) {
                      onHit?.();
                      // Only cloned JSON presentation rows leave the cache.
                      return { results: JSON.parse(hit.body), success: true };
                    }
                    // Do not coalesce pending I/O: workerd owns every read
                    // until its original request completes.
                    const result = (await query.all()) as {
                      results?: unknown;
                      success?: boolean;
                    };
                    if (result?.success === false || !Array.isArray(result?.results))
                      return result;
                    // An absent market is never remembered: new activations
                    // must be visible on their next first-paint request.
                    if (result.results.length !== 1) return result;
                    try {
                      const body = JSON.stringify(result.results);
                      const bytes = new TextEncoder().encode(body).byteLength;
                      const until = startedAt + MARKET_COMPLETED_TTL_MS;
                      if (
                        bytes > 0 &&
                        bytes <= MARKET_COMPLETED_MAX_ITEM_BYTES &&
                        until > Date.now()
                      ) {
                        const current = liveMarketCache(bindingScope, Date.now());
                        const previous = current.entries.get(key);
                        if (previous) {
                          current.bytes -= previous.bytes;
                          current.entries.delete(key);
                        }
                        while (
                          current.entries.size >= MARKET_COMPLETED_MAX_ITEMS ||
                          current.bytes + bytes > MARKET_COMPLETED_MAX_BYTES
                        ) {
                          const oldest = current.entries.entries().next().value as
                            | [string, CompletedMarketEntry]
                            | undefined;
                          if (!oldest) break;
                          current.entries.delete(oldest[0]);
                          current.bytes -= oldest[1].bytes;
                        }
                        current.entries.set(key, { body, bytes, until });
                        current.bytes += bytes;
                      }
                    } catch {
                      // An unserializable presentation row is not cacheable;
                      // it must never turn a successful D1 read into a 503.
                    }
                    return result;
                  };
                },
              });
            };
          },
        });
      };
    },
  });
}
