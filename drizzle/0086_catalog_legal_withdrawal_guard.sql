-- Fail-closed legal guard. Must be installed on PRIMARY rights D1 before
-- asynchronous catalog normalization/index publication is enabled.
-- The trigger is confined to authoritative status, offer and grant rows.
-- Never use independent metadata/FTS as a source of legal permission.
CREATE TRIGGER IF NOT EXISTS catalog_source_legal_withdrawal_au
AFTER UPDATE OF copyright,ingest_status,rights_status,commercial_use_status,
 rights_territories_json,rights_evidence_url,source_metadata_json
ON gutenberg_source_cache
WHEN new.copyright IS NOT 0 OR new.ingest_status<>'active'
 OR new.rights_status<>'public-domain' OR new.commercial_use_status<>'approved'
 OR old.rights_evidence_url IS NOT new.rights_evidence_url
 OR COALESCE(json_extract(old.source_metadata_json,'$.rightsFingerprint'),'')
    IS NOT COALESCE(json_extract(new.source_metadata_json,'$.rightsFingerprint'),'')
 OR EXISTS (
    SELECT 1 FROM json_each(old.rights_territories_json) previous_country
    WHERE NOT EXISTS (
      SELECT 1 FROM json_each(new.rights_territories_json) next_country
      WHERE upper(next_country.value)=upper(previous_country.value)
    )
 )
BEGIN
 UPDATE rights_grants SET status='suspended',updated_at=datetime('now')
 WHERE edition_id='ed_gutenberg_'||new.id AND status='active'
   AND source='gutenberg-'||new.source_id||'-public-domain'
   AND decision='allow'
   AND (
      new.copyright IS NOT 0 OR new.ingest_status<>'active'
      OR new.rights_status<>'public-domain'
      OR new.commercial_use_status<>'approved'
      OR old.rights_evidence_url IS NOT new.rights_evidence_url
      OR COALESCE(json_extract(old.source_metadata_json,'$.rightsFingerprint'),'')
         IS NOT COALESCE(json_extract(new.source_metadata_json,'$.rightsFingerprint'),'')
      OR NOT EXISTS (
        SELECT 1 FROM json_each(new.rights_territories_json) jt
        WHERE upper(jt.value)=upper(rights_grants.territory_code)
      )
   );
 UPDATE products SET storefront_status='inactive',updated_at=datetime('now')
 WHERE id='prd_gutenberg_'||new.id
   AND (new.copyright IS NOT 0 OR new.ingest_status<>'active'
    OR new.rights_status<>'public-domain' OR new.commercial_use_status<>'approved');
 UPDATE offers SET active=0,updated_at=datetime('now')
 WHERE product_id='prd_gutenberg_'||new.id AND active=1
   AND (new.copyright IS NOT 0 OR new.ingest_status<>'active'
    OR new.rights_status<>'public-domain' OR new.commercial_use_status<>'approved');
 UPDATE editions SET release_status='unavailable',updated_at=datetime('now')
 WHERE id='ed_gutenberg_'||new.id
   AND (new.copyright IS NOT 0 OR new.ingest_status<>'active'
    OR new.rights_status<>'public-domain' OR new.commercial_use_status<>'approved');
 UPDATE catalog_search_documents SET suppressed=1,availability='unavailable',
 updated_at=datetime('now')
 WHERE product_id='prd_gutenberg_'||new.id AND suppressed<>1
   AND (new.copyright IS NOT 0 OR new.ingest_status<>'active'
    OR new.rights_status<>'public-domain' OR new.commercial_use_status<>'approved');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS catalog_source_legal_withdrawal_ad
AFTER DELETE ON gutenberg_source_cache
BEGIN
 UPDATE rights_grants SET status='suspended',updated_at=datetime('now')
 WHERE edition_id='ed_gutenberg_'||old.id
   AND source='gutenberg-'||old.source_id||'-public-domain'
   AND decision='allow' AND status='active';
 UPDATE products SET storefront_status='inactive',updated_at=datetime('now')
 WHERE id='prd_gutenberg_'||old.id;
 UPDATE offers SET active=0,updated_at=datetime('now')
 WHERE product_id='prd_gutenberg_'||old.id AND active=1;
 UPDATE editions SET release_status='unavailable',updated_at=datetime('now')
 WHERE id='ed_gutenberg_'||old.id;
 UPDATE catalog_search_documents SET suppressed=1,availability='unavailable',
 updated_at=datetime('now')
 WHERE product_id='prd_gutenberg_'||old.id AND suppressed<>1;
END;
