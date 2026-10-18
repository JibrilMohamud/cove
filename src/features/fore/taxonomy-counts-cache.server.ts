import type { CatalogDB } from "./catalog-model.server";
import { writeCatalogCache } from "./catalog-cache.server";

export type TaxonomyCountRow = { node_id: string; product_count: number };
const PREFIX = "taxonomy-counts:v1:";
const MAX_ENTRIES = 128;
const TTL_MS = 600_000;

/**
 * These are PRESENTATION counts, not products, identities, entitlement, or
 * access decisions. Book listings, checkout and delivery must separately
 * check current territorial rights on primary D1 even when counts are cached.
 *
 * The expensive full-market rights aggregation previously ran on every
 * navigation, competing with short latency-critical authorizations.
 * Cache the bounded counts only, per territory/language, for <=10 minutes.
 * Recompute synchronously on miss (fail-closed for malformed/unavailable cache).
 */
export async function presentationTaxonomyCounts(
  db: CatalogDB,
  territory: string,
  language: string,
  queryLive: () => Promise<TaxonomyCountRow[]>,
  nowMs = () => Date.now(),
): Promise<TaxonomyCountRow[]> {
  // Include both rights territory and content language, but never
  // account/session/private user data. Lowercase normalization mirrors the
  // existing lower(language_code)=lower(?) SQL predicate.
  const territoryCode = territory.toUpperCase();
  const localeCode = language.toLowerCase();
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([territoryCode, localeCode])),
  );
  const hash = [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, "0")).join("");
  const key = PREFIX + hash;

  try {
    const cached = await db
      .prepare("SELECT body FROM api_cache WHERE key=? AND expires_at>?")
      .bind(key, nowMs())
      .first<{ body: string }>();
    if (cached) {
      const data: unknown = JSON.parse(cached.body);
      if (
        Array.isArray(data) &&
        data.length <= 300 &&
        data.every(
          (row) =>
            row &&
            typeof row === "object" &&
            typeof row.node_id === "string" &&
            row.node_id.length <= 256 &&
            Number.isSafeInteger(row.product_count) &&
            row.product_count >= 0,
        )
      )
        return data as TaxonomyCountRow[];
    }
  } catch {
    // Cache faults may never allow a book; recompute current legal counts.
  }

  const live = await queryLive();
  try {
    await writeCatalogCache(
      db,
      key,
      JSON.stringify(live),
      nowMs() + TTL_MS,
      PREFIX,
      MAX_ENTRIES,
    );
  } catch {
    // Cache write failure must not fail the actual fresh taxonomy response.
  }
  return live;
}
