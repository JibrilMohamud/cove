import type { CatalogDB } from "./catalog-model.server";

const LEASE_MS = 45_000;
const PREFIX = "search-facets-refresh:v2:";

export type FacetRefreshGuard = { key: string; owner: string; nowMs: number };

/**
 * One D1-conditional owner per display-only public facet cache key.
 * All work must be scheduled by the current request's waitUntil AFTER the
 * product page and its authoritative rights checks have finished.
 * No Worker-global promise, grant, offer, entitlement or product IDs are cached.
 */
export async function refreshLeasedSearchFacets(
  db: CatalogDB,
  displayKey: string,
  compute: (guard: FacetRefreshGuard) => Promise<void>,
  nowMs = () => Date.now(),
): Promise<boolean> {
  if (!/^search-facets:v2:[a-f0-9]{64}$/.test(displayKey))
    throw new Error("Invalid public facet cache key");
  const refreshKey = PREFIX + displayKey.slice("search-facets:v2:".length);
  const owner = crypto.randomUUID();
  const lease = await db
    .prepare(
      `INSERT INTO api_cache(key,body,expires_at) VALUES(?,?,?)
       ON CONFLICT(key) DO UPDATE SET
         body=excluded.body,expires_at=excluded.expires_at
       WHERE api_cache.expires_at<=?
       RETURNING body`,
    )
    .bind(refreshKey, owner, nowMs() + LEASE_MS, nowMs())
    .first<{ body: string }>();
  if (lease?.body !== owner) return false;
  try {
    await compute({ key: refreshKey, owner, nowMs: nowMs() });
    return true;
  } finally {
    // Never delete another refresh's replacement lease after timeout.
    await db
      .prepare("DELETE FROM api_cache WHERE key=? AND body=?")
      .bind(refreshKey, owner)
      .run()
      .catch(() => undefined);
  }
}
