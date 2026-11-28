import { dispatchQaOperationalWrite } from "../../storefront-strangler/qa-owner-operational-protocol";
import type { CatalogDB } from "./catalog-model.server";

/** Recycle expired/oldest entries atomically, rather than stop caching new URLs. */
export async function writeCatalogCache(
  db: CatalogDB,
  key: string,
  body: string,
  expiresAt: number,
  prefix: string,
  limit: number,
  guard?: { key: string; owner: string; nowMs: number },
) {
  const remote = dispatchQaOperationalWrite(db, {
    kind: "cache.write",
    key,
    body,
    expiresAt,
    prefix: prefix as
      | "search-counts:v1:"
      | "search-facets:v2:"
      | "search-page:v1:"
      | "taxonomy-counts:v1:"
      | "public-api:v2:",
    limit: limit as 128 | 256,
    guard,
  });
  if (remote) {
    await remote;
    return;
  }
  // A conditional leased refresh must publish atomically with the owner
  // check inside the D1 transaction. A previous owner's result can never
  // overwrite a replacement refresh after the original lease expires.
  const write = guard
    ? db
        .prepare(
          `INSERT INTO api_cache(key,body,expires_at)
           SELECT ?,?,? WHERE EXISTS(
             SELECT 1 FROM api_cache
             WHERE key=? AND body=? AND expires_at>?
           ) ON CONFLICT(key) DO UPDATE
           SET body=excluded.body,expires_at=excluded.expires_at`,
        )
        .bind(key, body, expiresAt, guard.key, guard.owner, guard.nowMs)
    : db
        .prepare(
          "INSERT INTO api_cache(key,body,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,expires_at=excluded.expires_at",
        )
        .bind(key, body, expiresAt);
  // Pruning is fenced too: an expired refresh must not evict a newer
  // owner's still-displayable count row before it loses its guarded upsert.
  const leaseFence = guard
    ? " AND EXISTS(SELECT 1 FROM api_cache lease WHERE lease.key=? AND lease.body=? AND lease.expires_at>?)"
    : "";
  const leaseBinds = guard ? [guard.key, guard.owner, guard.nowMs] : [];
  await db.batch([
    db
      .prepare(
        "DELETE FROM api_cache WHERE key IN (SELECT key FROM api_cache WHERE substr(key,1,length(?))=? AND expires_at<=? LIMIT ?)" +
          leaseFence,
      )
      .bind(prefix, prefix, Date.now(), limit, ...leaseBinds),
    db
      .prepare(
        `DELETE FROM api_cache WHERE key IN (SELECT key FROM api_cache WHERE substr(key,1,length(?))=? ORDER BY expires_at,key LIMIT CASE WHEN NOT EXISTS(SELECT 1 FROM api_cache WHERE key=?) AND (SELECT count(*) FROM api_cache WHERE substr(key,1,length(?))=?)>=? THEN 1 ELSE 0 END)` +
          leaseFence,
      )
      .bind(prefix, prefix, key, prefix, prefix, limit, ...leaseBinds),
    write,
  ]);
}
