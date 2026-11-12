/**
 * Single-isolate, staging-only in-flight deduplication of the exact anonymous
 * market/locale/translation SELECT. This is PUBLIC presentation metadata.
 * No legal rights, grants, offers, entitlements or catalog rows are shared.
 *
 * A late arrival may share a read started <=300ms ago, but completed reads
 * are removed immediately and NEVER cached. In all cases, the independent
 * authoritative D1 retail-availability query still runs for each request.
 */
type MarketFlight = { startedAt: number; promise: Promise<unknown> };
const flights = new WeakMap<object, Map<string, MarketFlight>>();
const MAX_FLIGHTS_PER_BINDING = 8;
const MAX_JOIN_AGE_MS = 300;

function safeMarketKey(sql: string, parameters: unknown[]): string | null {
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
  db: object,
  sql: string,
  parameters: unknown[],
  read: () => Promise<T>,
  onJoined?: () => void,
): Promise<T> {
  const key = safeMarketKey(sql, parameters);
  if (key === null) return read();
  let active = flights.get(db);
  if (!active) {
    active = new Map();
    flights.set(db, active);
  }
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
 * The binding, not request IP/account, scopes the bounded in-flight map.
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
                      coalesceMarketRead(target, sql, parameters, () => query.all(), onJoined);
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
