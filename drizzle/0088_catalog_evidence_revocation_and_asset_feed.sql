-- Primary rights database. Existing migration 0086 covers source-level
-- withdrawal; this one covers legal-evidence revocation, which may happen
-- independently of any source-cache update.
-- Revocation is synchronous with its evidence mutation, never driven by a
-- secondary D1, cache TTL, queue, KV or background replay.
CREATE TRIGGER IF NOT EXISTS catalog_evidence_withdrawal_au
AFTER UPDATE OF status,determination,territory_code,evidence_url,evidence_hash,source_id,cache_id
ON gutenberg_rights_evidence
WHEN old.status='approved' AND (
   new.status<>'approved' OR new.determination<>'public-domain'
   OR old.territory_code IS NOT new.territory_code
   OR old.evidence_url IS NOT new.evidence_url
   OR old.evidence_hash IS NOT new.evidence_hash
   OR old.source_id IS NOT new.source_id
   OR old.cache_id IS NOT new.cache_id
)
BEGIN
 UPDATE rights_grants SET status='suspended',updated_at=datetime('now')
 WHERE edition_id='ed_gutenberg_'||old.cache_id
   AND upper(territory_code)=upper(old.territory_code)
   AND status='active' AND decision='allow'
   AND source='gutenberg-'||old.source_id||'-public-domain';
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS catalog_evidence_withdrawal_ad
AFTER DELETE ON gutenberg_rights_evidence
WHEN old.status='approved' AND old.determination='public-domain'
BEGIN
 UPDATE rights_grants SET status='suspended',updated_at=datetime('now')
 WHERE edition_id='ed_gutenberg_'||old.cache_id
   AND upper(territory_code)=upper(old.territory_code)
   AND status='active' AND decision='allow'
   AND source='gutenberg-'||old.source_id||'-public-domain';
END;
--> statement-breakpoint
-- Changing source identity/page under an existing licensed edition invalidates
-- evidence provenance even when the source country and status stay unchanged.
CREATE TRIGGER IF NOT EXISTS catalog_source_provenance_change_au
AFTER UPDATE OF source_item_id,source_url ON gutenberg_source_cache
WHEN old.source_item_id IS NOT new.source_item_id
 OR old.source_url IS NOT new.source_url
BEGIN
 UPDATE rights_grants SET status='suspended',updated_at=datetime('now')
 WHERE edition_id='ed_gutenberg_'||old.id
   AND source='gutenberg-'||old.source_id||'-public-domain'
   AND decision='allow' AND status='active';
END;
--> statement-breakpoint
-- Existing deployed 0085 notification trigger must be replaced additively;
-- in-place changes to old migration files are NOT executed on live D1.
DROP TRIGGER IF EXISTS catalog_index_source_au;
--> statement-breakpoint
CREATE TRIGGER catalog_index_source_au
AFTER UPDATE OF title,summary,authors_json,subjects_json,bookshelves_json,languages_json,
 formats_json,rights_status,commercial_use_status,ingest_status,copyright,
 source_id,source_item_id,source_url,rights_territories_json,rights_evidence_url,
 source_metadata_json,content_hash,epub_status
ON gutenberg_source_cache
WHEN old.title IS NOT new.title OR old.summary IS NOT new.summary
 OR old.authors_json IS NOT new.authors_json
 OR old.subjects_json IS NOT new.subjects_json
 OR old.bookshelves_json IS NOT new.bookshelves_json
 OR old.languages_json IS NOT new.languages_json
 OR old.formats_json IS NOT new.formats_json
 OR old.rights_status IS NOT new.rights_status
 OR old.commercial_use_status IS NOT new.commercial_use_status
 OR old.ingest_status IS NOT new.ingest_status OR old.copyright IS NOT new.copyright
 OR old.source_id IS NOT new.source_id OR old.source_item_id IS NOT new.source_item_id
 OR old.source_url IS NOT new.source_url
 OR old.rights_territories_json IS NOT new.rights_territories_json
 OR old.rights_evidence_url IS NOT new.rights_evidence_url
 OR old.content_hash IS NOT new.content_hash
 OR old.epub_status IS NOT new.epub_status
 OR COALESCE(json_extract(old.source_metadata_json,'$.rightsFingerprint'),'') IS NOT
    COALESCE(json_extract(new.source_metadata_json,'$.rightsFingerprint'),'')
BEGIN
 INSERT INTO catalog_index_changefeed(cache_id,operation) VALUES(new.id,'upsert');
END;
--> statement-breakpoint
-- Narrow country/evidence filter for final authoritative query.
-- The result remains a primary read, never cached rights.
CREATE INDEX IF NOT EXISTS idx_gutenberg_evidence_approved_territory
 ON gutenberg_rights_evidence(cache_id,territory_code)
 WHERE status='approved' AND determination='public-domain';
