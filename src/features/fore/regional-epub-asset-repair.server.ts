import type { CoveEnv } from "./api.server";

/**
 * Bounded, operator-triggered reconciliation of completed regional EPUBs.
 * Never grants rights, never re-ingests upstream assets, never runs on a customer
 * request. Verify the exact canonical object in private R2 before adding a
 * missing catalog pointer. Callers must supply the returned cursor to advance.
 */
export async function repairRegionalEpubAssets(
  env: Pick<CoveEnv, "DB" | "BUCKET">,
  options: { after?: string; limit?: number } = {},
) {
  if (!env.BUCKET?.head || !env.BUCKET?.get) return { skipped: "no_private_r2" };
  const suppliedAfter = options.after ?? "";
  if (!/^[a-z0-9_]{0,90}$/.test(suppliedAfter))
    throw new Error("Invalid regional asset repair cursor");
  // Only AU/CA/EU sources can be selected here. Start at the first regional
  // ID prefix, otherwise an empty cursor scans unrelated US Gutenberg rows.
  const after = suppliedAfter > "pga" ? suppliedAfter : "pga";
  const limit = Math.max(1, Math.min(16, Math.floor(options.limit ?? 8) || 8));
  // Source-level approval is insufficient: a separate operator could revoke
  // every live territorial grant without modifying the Gutenberg source row.
  // The candidate scan and EACH mutation require a currently valid grant.
  const liveGrant =
    " EXISTS(SELECT 1 FROM rights_grants g" +
    " WHERE g.edition_id=p.edition_id AND g.format='ebook'" +
    " AND g.sales_channel='retail' AND g.status='active' AND g.decision='allow'" +
    " AND g.source='gutenberg-'||c.source_id||'-public-domain'" +
    " AND g.territory_code IN (SELECT value FROM json_each(" +
    " CASE WHEN json_valid(c.rights_territories_json)" +
    " THEN c.rights_territories_json ELSE '[]' END))" +
    " AND (g.starts_at IS NULL OR datetime(g.starts_at)<=datetime('now'))" +
    " AND (g.ends_at IS NULL OR datetime(g.ends_at)>datetime('now'))" +
    // Deny precedence is territory-specific: a revoked CA grant cannot
    // invalidate an independent, still-permitted AU grant for the same EPUB.
    " AND NOT EXISTS(SELECT 1 FROM rights_grants deny" +
    " WHERE deny.edition_id=p.edition_id AND deny.format='ebook'" +
    " AND deny.sales_channel='retail' AND deny.status='active'" +
    " AND deny.decision='deny' AND deny.territory_code=g.territory_code" +
    " AND (deny.starts_at IS NULL OR datetime(deny.starts_at)<=datetime('now'))" +
    " AND (deny.ends_at IS NULL OR datetime(deny.ends_at)>datetime('now'))))";

  const rows = (
    await env.DB.prepare(
      "SELECT c.id,c.content_hash,p.edition_id," +
        " COALESCE(json_extract(c.formats_json,'$.\"application/epub+zip\"')," +
        " json_extract(c.formats_json,'$.\"application/epub+zip;\"')," +
        " json_extract(c.formats_json,'$.\"text/html\"'),'') source_url" +
        " FROM gutenberg_source_cache c INDEXED BY sqlite_autoindex_gutenberg_source_cache_1" +
        " CROSS JOIN products p ON p.source_external_id=c.id" +
        " AND p.source_name='gutenberg' AND p.format='ebook'" +
        " LEFT JOIN digital_assets d ON d.edition_id=p.edition_id AND d.kind='epub'" +
        " LEFT JOIN asset_versions v ON v.id=d.current_version_id" +
        " LEFT JOIN regional_epub_repair_receipts rr" +
        " ON rr.source_id=c.id AND rr.content_hash=c.content_hash" +
        " WHERE c.source_id IN ('pg_au','pg_ca','pg_eu')" +
        " AND c.epub_status='completed' AND c.ingest_status='active'" +
        " AND c.rights_status='public-domain' AND c.commercial_use_status='approved'" +
        " AND" +
        liveGrant +
        " AND COALESCE(c.content_hash,'')<>'' AND c.id>?" +
        " AND (d.id IS NULL OR v.id IS NULL OR COALESCE(v.object_key,'')=''" +
        " OR rr.status='pending')" +
        " ORDER BY c.id LIMIT ?",
    )
      .bind(after, limit)
      .all<{
        id: string;
        content_hash: string;
        edition_id: string;
        source_url: string;
      }>()
  ).results;
  let repaired = 0;
  let missingOrMismatched = 0;
  let conflicts = 0;
  let nextAfter = after;
  // The rights state is checked again by every write. Reader/checkout APIs
  // remain independently authoritative for every actual delivery.
  const eligible =
    "EXISTS(SELECT 1 FROM gutenberg_source_cache c" +
    " JOIN products p ON p.source_external_id=c.id" +
    " WHERE c.id=? AND p.edition_id=? AND p.source_name='gutenberg'" +
    " AND c.source_id IN ('pg_au','pg_ca','pg_eu')" +
    " AND c.epub_status='completed' AND c.ingest_status='active'" +
    " AND c.rights_status='public-domain' AND c.commercial_use_status='approved'" +
    " AND" +
    liveGrant +
    " AND c.content_hash=?)";
  for (const row of rows) {
    nextAfter = row.id;
    const key = "epubs/" + row.id + ".epub";
    const stored = await env.BUCKET.head(key);
    if (
      !stored ||
      stored.size <= 0 ||
      stored.customMetadata?.sha256 !== row.content_hash ||
      stored.httpMetadata?.contentType !== "application/epub+zip"
    ) {
      missingOrMismatched++;
      continue;
    }
    // R2 HEAD verifies catalog metadata, not actual bytes. In this disabled-
    // by-default operator-only lane, fully hash the original before *any*
    // primary catalog write; never download or re-convert an upstream EPUB.
    // The explicit bound prevents a corrupt object from exhausting Worker RAM.
    if (stored.size > 25 * 1024 * 1024) {
      missingOrMismatched++;
      continue;
    }
    const body = await env.BUCKET.get(key);
    if (!body || body.size !== stored.size) {
      missingOrMismatched++;
      continue;
    }
    const bytes = await body.arrayBuffer();
    if (bytes.byteLength !== stored.size) {
      missingOrMismatched++;
      continue;
    }
    const sha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    if (sha256 !== row.content_hash) {
      missingOrMismatched++;
      continue;
    }
    const now = new Date().toISOString();
    // The verified R2 object is recorded before catalog mutations. If a tick
    // crashes at any later point, the pending receipt re-enters the candidate
    // frontier even when a prior attempt linked the final asset pointer.
    await env.DB.prepare(
      "INSERT OR IGNORE INTO regional_epub_repair_receipts" +
        "(source_id,content_hash,edition_id,status,verified_at)" +
        " SELECT ?,?,?,'pending',? WHERE " +
        eligible,
    )
      .bind(row.id, row.content_hash, row.edition_id, now, row.id, row.edition_id, row.content_hash)
      .run();
    // Statements must remain rights-guarded individually. A D1 batch is a
    // single atomic transaction: no intermediate asset pointer is published.
    const insertAsset = env.DB.prepare(
      "INSERT OR IGNORE INTO digital_assets(id,edition_id,kind,drm_status,downloadable,created_at,updated_at)" +
        " SELECT ?,?,'epub','none',1,?,? WHERE " +
        eligible,
    ).bind(
      "asset_epub_gutenberg_" + row.id,
      row.edition_id,
      now,
      now,
      row.id,
      row.edition_id,
      row.content_hash,
    );
    const insertVersion = env.DB.prepare(
      "INSERT OR IGNORE INTO asset_versions(id,asset_id,version_number,source_url,object_key,mime_type,sha256,created_at)" +
        " SELECT ?,d.id,1,?,?,'application/epub+zip',?,?" +
        " FROM digital_assets d WHERE d.edition_id=? AND d.kind='epub' AND " +
        eligible,
    ).bind(
      "assetver_epub_gutenberg_" + row.id,
      row.source_url,
      key,
      row.content_hash,
      now,
      row.edition_id,
      row.id,
      row.edition_id,
      row.content_hash,
    );
    const updateVersion = env.DB.prepare(
      "UPDATE asset_versions SET object_key=?,sha256=?" +
        " WHERE asset_id=(SELECT id FROM digital_assets WHERE edition_id=? AND kind='epub')" +
        " AND version_number=1 AND COALESCE(object_key,'')='' AND " +
        eligible,
    ).bind(key, row.content_hash, row.edition_id, row.id, row.edition_id, row.content_hash);
    const promoteAsset = env.DB.prepare(
      "UPDATE digital_assets AS d SET current_version_id=(" +
        " SELECT v.id FROM asset_versions v WHERE v.asset_id=d.id" +
        " AND v.version_number=1 AND v.object_key=? AND v.sha256=?)" +
        " WHERE d.edition_id=? AND d.kind='epub'" +
        " AND (d.current_version_id IS NULL OR NOT EXISTS(" +
        " SELECT 1 FROM asset_versions prev WHERE prev.id=d.current_version_id" +
        " AND COALESCE(prev.object_key,'')<>'')) AND " +
        eligible,
    ).bind(key, row.content_hash, row.edition_id, row.id, row.edition_id, row.content_hash);
    try {
      await env.DB.batch([insertAsset, insertVersion, updateVersion, promoteAsset]);
    } catch (error) {
      console.warn("regional_epub_repair_batch_retry", row.id, String(error).slice(0, 140));
      conflicts++;
      continue;
    }
    // Only mark the receipt complete when the *actual* current version and
    // source SHA match AND the canonical live-rights predicate still holds.
    // If this final ACK fails or is interrupted, a subsequent tick replays
    // the same idempotent batch and then retries the receipt ACK.
    const completed = await env.DB.prepare(
      "UPDATE regional_epub_repair_receipts SET status='completed',completed_at=?" +
        " WHERE source_id=? AND content_hash=? AND status='pending'" +
        " AND EXISTS(SELECT 1 FROM digital_assets d" +
        " JOIN asset_versions v ON v.id=d.current_version_id" +
        " WHERE d.edition_id=? AND d.kind='epub' AND v.object_key=? AND v.sha256=?)" +
        " AND " +
        eligible +
        " RETURNING source_id",
    )
      .bind(
        now,
        row.id,
        row.content_hash,
        row.edition_id,
        key,
        row.content_hash,
        row.id,
        row.edition_id,
        row.content_hash,
      )
      .first();
    if (completed) repaired++;
    else conflicts++;
  }
  return {
    scanned: rows.length,
    repaired,
    missingOrMismatched,
    conflicts,
    nextAfter,
    maybeMore: rows.length === limit,
  };
}
