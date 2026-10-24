import type { CatalogDB } from "./catalog-model.server";
import { writeCatalogCache } from "./catalog-cache.server";

export type TaxonomyCountRow = { node_id: string; product_count: number };
const PREFIX = "taxonomy-counts:v1:";
const MAX_ENTRIES = 128;
const TTL_MS = 600_000;
const REFRESH_EARLY_MS = 120_000;
const MAX_STALE_MS = 3_600_000;
const LEASE_MS = 30_000;
const REFRESH_PREFIX = "taxonomy-counts-refresh:v1:";

type DeferredWork = (work: Promise<unknown>) => void;

function validatedCounts(body: string): TaxonomyCountRow[] | null {
  try {
    const data: unknown = JSON.parse(body);
    return Array.isArray(data) &&
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
      ? (data as TaxonomyCountRow[])
      : null;
  } catch {
    return null;
  }
}

/**
 * D1-backed conditional lease, NOT a Worker-global Promise. Multiple
 * requests/colos cannot begin the same seconds-long presentation aggregation
 * at once. Lease state is separate from display counts and never licenses a
 * title. A crash expires the lease automatically.
 */
async function refreshPresentationCounts(
  db: CatalogDB,
  key: string,
  refreshKey: string,
  queryLive: () => Promise<TaxonomyCountRow[]>,
  nowMs: () => number,
) {
  // A lease can expire while a slow rights-count aggregation is running.
  // Only its owner may publish results or remove the lease. In particular,
  // an older request may NOT delete a newer owner's lease after takeover.
  const owner = crypto.randomUUID();
  const acquired = await db
    .prepare(
      `INSERT INTO api_cache(key,body,expires_at) VALUES(?,?,?)
       ON CONFLICT(key) DO UPDATE SET
         body=excluded.body,expires_at=excluded.expires_at
       WHERE api_cache.expires_at<=?
       RETURNING body`,
    )
    .bind(refreshKey, owner, nowMs() + LEASE_MS, nowMs())
    .first<{ body: string }>();
  if (acquired?.body !== owner) return;

  let succeeded = false;
  try {
    // Another request may have refreshed between our cache read and lease
    // acquisition. Recheck after winning; do not recompute fresh labels.
    const latest = await db
      .prepare("SELECT body,expires_at FROM api_cache WHERE key=?")
      .bind(key)
      .first<{ body: string; expires_at: number }>();
    if (latest && latest.expires_at - nowMs() > REFRESH_EARLY_MS && validatedCounts(latest.body)) {
      succeeded = true;
      return;
    }
    const current = await queryLive();
    if (!validatedCounts(JSON.stringify(current))) throw new Error("Invalid taxonomy counts");
    // A batch-transaction conditional UPSERT fences this result by the
    // current lease owner. If the lease expired or another request won a
    // takeover, the obsolete result cannot replace the newer count.
    await writeCatalogCache(
      db,
      key,
      JSON.stringify(current),
      nowMs() + TTL_MS,
      PREFIX,
      MAX_ENTRIES,
      { key: refreshKey, owner, nowMs: nowMs() },
    );
    succeeded = true;
  } finally {
    // Keep a failed refresh's bounded lease as retry backoff. Deleting it on
    // failure let every following request immediately rerun the failing scan.
    // An expired lease can still be taken over, with the same owner fencing.
    if (succeeded) {
      // Protect a replacement lease from completion of an older request.
      await db
        .prepare("DELETE FROM api_cache WHERE key=? AND body=?")
        .bind(refreshKey, owner)
        .run()
        .catch(() => undefined);
    }
  }
}

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
  defer?: DeferredWork,
  state?: { pending: boolean },
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
  const refreshKey = REFRESH_PREFIX + hash;
  const now = nowMs();

  try {
    const cached = await db
      .prepare(
        `SELECT counts.body,counts.expires_at,
        (SELECT expires_at FROM api_cache WHERE key=?) refresh_expires_at
        FROM (SELECT 1) seed LEFT JOIN api_cache counts ON counts.key=?`,
      )
      .bind(refreshKey, key)
      .first<{ body: string; expires_at: number; refresh_expires_at: number | null }>();
    const counts = cached ? validatedCounts(cached.body) : null;
    const expiresAt = Number(cached?.expires_at || 0);

    if (defer) {
      // Every background task belongs to THIS request's execution context.
      // Do not share D1 promises across Cloudflare requests or isolates.
      if (
        (!counts || expiresAt - now <= REFRESH_EARLY_MS) &&
        Number(cached?.refresh_expires_at || 0) <= now
      ) {
        defer(
          refreshPresentationCounts(db, key, refreshKey, queryLive, nowMs).catch((error) => {
            console.warn(
              "Presentation taxonomy refresh unavailable",
              error instanceof Error ? error.message : "unknown",
            );
          }),
        );
      }
      if (counts && expiresAt + MAX_STALE_MS > now) return counts;
      // Cold-cache rendering must never block an entire catalog on a
      // multi-second display-only count aggregation. The background task
      // fills the counts; actual book rights remain checked per request.
      if (state) state.pending = true;
      return [];
    }

    // Legacy/local adapters without waitUntil retain exact synchronous
    // semantics and fail-closed legal book checks.
    if (counts && expiresAt > now) return counts;
  } catch {
    // A failed cache read must NOT trigger an expensive foreground
    // aggregation on a congested primary. Return a display-only pending
    // response; retry the cache lookup on the next request. Legal rights are
    // never inferred from taxonomy count labels.
    if (defer) {
      if (state) state.pending = true;
      return [];
    }
  }

  const live = await queryLive();
  try {
    await writeCatalogCache(db, key, JSON.stringify(live), nowMs() + TTL_MS, PREFIX, MAX_ENTRIES);
  } catch {
    // Cache write failure must not fail the actual fresh taxonomy response.
  }
  return live;
}

/**
 * A new per-miss, independent D1 read-replica session for display-count
 * aggregation ONLY. Replica lag can make a count label slightly stale but
 * MUST NEVER authorize a catalog listing, download, sale, or reading access.
 *
 * Cache hit reads and cache maintenance remain on the caller's db.
 * On local SQLite/test adapters lacking D1 Sessions, preserve exact behavior.
 */
export function taxonomyPresentationReadDb(db: CatalogDB): CatalogDB {
  const replicaCapable = db as CatalogDB & {
    withSession?: (consistency: "first-unconstrained") => CatalogDB;
  };
  return typeof replicaCapable.withSession === "function"
    ? replicaCapable.withSession("first-unconstrained")
    : db;
}
