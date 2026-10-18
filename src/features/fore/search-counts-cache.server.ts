import type { CatalogDB } from "./catalog-model.server";
import { writeCatalogCache } from "./catalog-cache.server";

const PREFIX = "search-counts:v1:";
const TTL_MS = 600_000;
const MAX_ENTRIES = 128;

/**
 * Search result ranking and page number do not change the eligible population
 * counted by the UI's total. The key preserves every other public filter and
 * the FTS expression (including the rights territory/currency/language).
 * It contains no account ID, entitlement or book ID.
 */
export function publicSearchCountIdentity<
  T extends { sort?: unknown; page?: unknown; limit?: unknown },
>(input: T, expression: string) {
  const { sort: _sort, page: _page, limit: _limit, ...scope } = input;
  return JSON.stringify([scope, expression]);
}

/**
 * Presentation-only search total, like the existing ten-minute page/facet
 * totals. Returning a cached NUMBER never grants any content: all result IDs
 * are computed/rechecked from the live authoritative retail rights view,
 * and every reader, download and checkout has independent primary-D1 checks.
 *
 * A cache failure or malformed value recomputes the scoped live COUNT.
 * Completed promises are not retained in Worker globals, and the cache
 * never contains authorized book IDs or private/account data.
 */
export async function presentationSearchCount<
  T extends { sort?: unknown; page?: unknown; limit?: unknown },
>(
  db: CatalogDB,
  input: T,
  expression: string,
  countLive: () => Promise<number>,
  nowMs = () => Date.now(),
): Promise<number> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(publicSearchCountIdentity(input, expression)),
  );
  const hash = [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, "0")).join("");
  const key = PREFIX + hash;
  try {
    const cached = await db
      .prepare("SELECT body FROM api_cache WHERE key=? AND expires_at>?")
      .bind(key, nowMs())
      .first<{ body: string }>();
    if (cached) {
      const value: unknown = JSON.parse(cached.body);
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
        return value;
    }
  } catch {
    // Missing/corrupt cache may never cause a rights or search decision.
  }
  const liveCount = await countLive();
  if (!Number.isSafeInteger(liveCount) || liveCount < 0)
    throw new Error("Invalid public search count");
  try {
    await writeCatalogCache(db, key, JSON.stringify(liveCount), nowMs() + TTL_MS, PREFIX, MAX_ENTRIES);
  } catch {
    // Best effort: a cache write failure never loses the live query result.
  }
  return liveCount;
}
