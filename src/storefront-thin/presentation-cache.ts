import { networkCountry, type StorefrontContext } from "../features/fore/localization.server";

type StagingEnv = {
  COVE_SSR_STAGING?: string;
  COVE_THIN_STOREFRONT?: string;
  COVE_THIN_METADATA_CACHE?: string;
  COVE_PERF_DATABASE_ID?: string;
  FORE_DEFAULT_TERRITORY?: string;
};

type Entry = { until: number; value: StorefrontContext };
const completed = new Map<string, Entry>();
const ttlMs = 2_000;
const maxEntries = 64;
const syntheticDbId = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";

/**
 * Experimental, staging-only cache for successful, anonymous presentation
 * metadata. The caller MUST still read primary-D1 retail rights on every
 * request; nothing in this module contains an offer, rights grant, entitlement
 * or a pending promise. Concurrent misses independently execute their reads.
 *
 * A bounded 2s staleness window applies ONLY to public locale, market,
 * payment-method display and published home-page copy. This experiment is
 * not approved for production or for authorizing a purchase.
 */
export async function loadThinPresentationContext(
  request: Request,
  env: StagingEnv,
  load: () => Promise<StorefrontContext>,
  now: () => number = Date.now,
): Promise<StorefrontContext> {
  const allowed =
    env.COVE_SSR_STAGING === "1" &&
    env.COVE_THIN_STOREFRONT === "synthetic-only" &&
    env.COVE_THIN_METADATA_CACHE === "1" &&
    env.COVE_PERF_DATABASE_ID === syntheticDbId;
  if (
    !allowed ||
    request.method !== "GET" ||
    ["authorization", "cookie", "oai-authenticated-user-id", "oai-authenticated-user-email",
     "x-fore-authenticated-user-id"].some((header) => request.headers.has(header))
  )
    return load();

  const language = request.headers.get("accept-language") || "";
  // No user-controlled unbounded keys, nor collisions caused by truncation.
  if (language.length > 256) return load();
  const country = networkCountry(request, env.FORE_DEFAULT_TERRITORY || "US").country;
  const key = JSON.stringify([syntheticDbId, country, language]);
  const instant = now();
  const cached = completed.get(key);
  if (cached && cached.until > instant) return structuredClone(cached.value);
  if (cached) completed.delete(key);

  // Deliberately NO singleflight / cross-request sharing of pending Worker I/O.
  // A failed D1 batch cannot populate the cache.
  const context = await load();
  if (context.rightsCountry !== country)
    throw new Error("Anonymous metadata country mismatch; refuse the cache.");
  completed.set(key, { until: now() + ttlMs, value: structuredClone(context) });
  if (completed.size > maxEntries) {
    const first = completed.keys().next().value;
    if (first !== undefined) completed.delete(first);
  }
  return context;
}
