import { networkCountry, resolveAnonymousHomepageContext } from "./localization.server";

/**
 * Deduplicate ONLY anonymous, public storefront presentation reads for a
 * brief burst within one Worker isolate. This is NOT a rights/entitlement,
 * book, grant, or session cache. Every response still executes its OWN
 * authoritative primary-D1 firstPaintStorefrontShelf query.
 *
 * The anonymous resolver depends on network country and Accept-Language;
 * untrusted identity/preferences (including any cookie) bypass this cache.
 * Coalesce only while an operation is pending and for at most two seconds
 * after success, so updates to market/currency/locale settings converge
 * quickly. Rejecting requests never leave poison promises behind.
 */
type Context = Awaited<ReturnType<typeof resolveAnonymousHomepageContext>>;
type ContextDb = Parameters<typeof resolveAnonymousHomepageContext>[0];
type Entry = { promise: Promise<Context>; expiresAt: number };
const entries = new Map<string, Entry>();
const maxEntries = 32;
const successTtlMs = 2000;

export function sharedAnonymousHomepageContext(
  db: ContextDb,
  request: Request,
  fallbackCountry: string,
): Promise<Context> {
  // The calling bootstrap already enforces identity absence; fail closed here
  // too so no future caller can accidentally cache personalized presentation.
  if (
    ["authorization", "cookie", "oai-authenticated-user-id", "oai-authenticated-user-email", "x-fore-authenticated-user-id"].some(
      (header) => request.headers.has(header),
    )
  )
    return resolveAnonymousHomepageContext(db, request, fallbackCountry);
  const language = request.headers.get("accept-language") || "";
  // Never truncate: that could alias two distinct locale negotiations.
  if (language.length > 256)
    return resolveAnonymousHomepageContext(db, request, fallbackCountry);
  const network = networkCountry(request, fallbackCountry);
  const key = JSON.stringify([
    network.country,
    network.source,
    fallbackCountry,
    language,
  ]);
  const previous = entries.get(key);
  if (previous && previous.expiresAt > Date.now()) return previous.promise;
  if (previous) entries.delete(key);
  while (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);

  // This first request's read-only metadata session may be shared by another
  // anonymous request in this isolate. No primary rights promise is shared.
  const entry: Entry = {
    promise: resolveAnonymousHomepageContext(db, request, fallbackCountry),
    expiresAt: Infinity,
  };
  entries.set(key, entry);
  void entry.promise.then(
    () => {
      entry.expiresAt = Date.now() + successTtlMs;
    },
    () => {
      if (entries.get(key) === entry) entries.delete(key);
    },
  );
  return entry.promise;
}
