-- Evidence-row mutations are authoritative events even when the source
-- cache's public metadata is unchanged. This outbox is ADVISORY ONLY.
-- Source-grant suspension is synchronous in migration 0088; this feed merely
-- retires asynchronous discovery text after that authoritative decision.
CREATE TRIGGER IF NOT EXISTS catalog_evidence_index_ai
AFTER INSERT ON gutenberg_rights_evidence
BEGIN
 INSERT INTO catalog_index_changefeed(cache_id,operation)
 VALUES(new.cache_id,'upsert');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS catalog_evidence_index_au
AFTER UPDATE OF cache_id,source_id,status,determination,territory_code,
 evidence_url,evidence_hash ON gutenberg_rights_evidence
WHEN old.cache_id IS NOT new.cache_id OR old.source_id IS NOT new.source_id
 OR old.status IS NOT new.status OR old.determination IS NOT new.determination
 OR old.territory_code IS NOT new.territory_code
 OR old.evidence_url IS NOT new.evidence_url
 OR old.evidence_hash IS NOT new.evidence_hash
BEGIN
 INSERT INTO catalog_index_changefeed(cache_id,operation)
 VALUES(old.cache_id,'upsert');
 INSERT INTO catalog_index_changefeed(cache_id,operation)
 SELECT new.cache_id,'upsert' WHERE new.cache_id<>old.cache_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS catalog_evidence_index_ad
AFTER DELETE ON gutenberg_rights_evidence
BEGIN
 INSERT INTO catalog_index_changefeed(cache_id,operation)
 VALUES(old.cache_id,'upsert');
END;
