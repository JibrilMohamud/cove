import type { CatalogDB } from "./catalog-model.server";

/** Recycle expired/oldest entries atomically, rather than stop caching new URLs. */
export async function writeCatalogCache(
  db: CatalogDB,
  key: string,
  body: string,
  expiresAt: number,
  prefix: string,
  limit: number,
) {
  await db.batch([
    db
      .prepare(
        "DELETE FROM api_cache WHERE key IN (SELECT key FROM api_cache WHERE substr(key,1,length(?))=? AND expires_at<=? LIMIT ?)",
      )
      .bind(prefix, prefix, Date.now(), limit),
    db
      .prepare(
        `DELETE FROM api_cache WHERE key IN (SELECT key FROM api_cache WHERE substr(key,1,length(?))=? ORDER BY expires_at,key LIMIT CASE WHEN NOT EXISTS(SELECT 1 FROM api_cache WHERE key=?) AND (SELECT count(*) FROM api_cache WHERE substr(key,1,length(?))=?)>=? THEN 1 ELSE 0 END)`,
      )
      .bind(prefix, prefix, key, prefix, prefix, limit),
    db
      .prepare(
        "INSERT INTO api_cache(key,body,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,expires_at=excluded.expires_at",
      )
      .bind(key, body, expiresAt),
  ]);
}
