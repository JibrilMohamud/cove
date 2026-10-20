/**
 * Coalesce *concurrent, identical, anonymous-only presentation lookups*.
 *
 * No cached completed results: after the promise settles the entry is gone.
 * Live book/catalog rights remain separate per-request primary-D1 queries.
 * Do NOT apply this to identity, checkout, signed-in user preferences or
 * any operation with a cookie, authorization or personalized headers.
 */
const inflight = new WeakMap<object, Map<string, Promise<unknown>>>();
const maxOutstanding = 24;

export function singleflightAnonymousPresentation<T>(
  dbIdentity: object,
  request: Request,
  trustedCountry: string,
  includeMarkets: boolean,
  operation: () => Promise<T>,
): Promise<T> {
  const h = request.headers;
  const language = h.get("accept-language") || "";
  if (
    request.method !== "GET" ||
    !/^[A-Z]{2}$/.test(trustedCountry) ||
    language.length > 140 ||
    h.has("cookie") ||
    h.has("authorization") ||
    h.has("oai-authenticated-user-id") ||
    h.has("x-fore-authenticated-user-id") ||
    h.has("x-fore-authenticated-user-email")
  ) return operation();

  const key = [trustedCountry, includeMarkets ? "all" : "one", language].join("|");
  let pending = inflight.get(dbIdentity);
  if (!pending) {
    pending = new Map();
    inflight.set(dbIdentity, pending);
  }
  const existing = pending.get(key);
  if (existing) return existing as Promise<T>;
  if (pending.size >= maxOutstanding) return operation();

  const promise = Promise.resolve().then(operation);
  pending.set(key, promise);
  // Never persist results or cached failures: this is *only* sharing live,
  // simultaneously executing presentation configuration work.
  const clear = () => {
    if (pending!.get(key) === promise) pending!.delete(key);
  };
  void promise.then(clear, clear);
  return promise;
}
