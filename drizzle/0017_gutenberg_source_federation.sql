-- Federated public-domain source infrastructure for Project Gutenberg US, Canada,
-- Australia, and country-scoped Project Gutenberg Europe material.
--
-- A source being enabled never grants rights by itself. Every normalized item must carry
-- an approved, append-only rights evidence record with the exact storefront territories
-- for which that source's public-domain determination is applicable.

CREATE TABLE gutenberg_sources (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  homepage_url text NOT NULL,
  catalog_url text NOT NULL,
  license_url text NOT NULL,
  publisher_id text NOT NULL,
  identifier_scheme text NOT NULL UNIQUE,
  jurisdiction_mode text NOT NULL CHECK(jurisdiction_mode IN ('single-territory','per-item-territories')),
  default_territory_code text REFERENCES territories(code) ON DELETE RESTRICT,
  feed_kind text NOT NULL CHECK(feed_kind IN ('gutendex-json','html-catalog','csv-catalog','rights-manifest')),
  enabled integer NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  priority integer NOT NULL DEFAULT 100,
  refresh_seconds integer NOT NULL DEFAULT 86400 CHECK(refresh_seconds>=300),
  max_items_per_run integer NOT NULL DEFAULT 250 CHECK(max_items_per_run BETWEEN 1 AND 5000),
  rights_policy text NOT NULL,
  commercial_policy text NOT NULL DEFAULT 'canonicalize-before-retail',
  trademark_cleanup_required integer NOT NULL DEFAULT 0 CHECK(trademark_cleanup_required IN (0,1)),
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX idx_gutenberg_sources_enabled ON gutenberg_sources(enabled,priority);

CREATE TABLE gutenberg_source_states (
  source_id text PRIMARY KEY REFERENCES gutenberg_sources(id) ON DELETE CASCADE,
  cursor text,
  cycle_started_at text,
  etag text,
  last_modified text,
  content_hash text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','running','backoff','degraded','failed')),
  last_run_at text,
  last_success_at text,
  last_error text NOT NULL DEFAULT '',
  attempts integer NOT NULL DEFAULT 0,
  total_catalog_count integer NOT NULL DEFAULT 0,
  seen_count integer NOT NULL DEFAULT 0,
  accepted_count integer NOT NULL DEFAULT 0,
  quarantined_count integer NOT NULL DEFAULT 0,
  next_run_at text,
  lease_token text,
  lease_until text,
  updated_at text NOT NULL
);
CREATE INDEX idx_gutenberg_source_states_due ON gutenberg_source_states(status,next_run_at);

ALTER TABLE gutenberg_source_cache ADD COLUMN source_id text NOT NULL DEFAULT 'pg_us';
ALTER TABLE gutenberg_source_cache ADD COLUMN source_item_id text NOT NULL DEFAULT '';
ALTER TABLE gutenberg_source_cache ADD COLUMN source_project text NOT NULL DEFAULT 'Project Gutenberg';
ALTER TABLE gutenberg_source_cache ADD COLUMN source_license_url text NOT NULL DEFAULT 'https://www.gutenberg.org/policy/license.html';
ALTER TABLE gutenberg_source_cache ADD COLUMN rights_status text NOT NULL DEFAULT 'public-domain' CHECK(rights_status IN ('pending','public-domain','permission','rejected','quarantined'));
ALTER TABLE gutenberg_source_cache ADD COLUMN rights_territories_json text NOT NULL DEFAULT '["US"]';
ALTER TABLE gutenberg_source_cache ADD COLUMN rights_evidence_url text NOT NULL DEFAULT '';
ALTER TABLE gutenberg_source_cache ADD COLUMN rights_checked_at text;
ALTER TABLE gutenberg_source_cache ADD COLUMN rights_evidence_id text;
ALTER TABLE gutenberg_source_cache ADD COLUMN commercial_use_status text NOT NULL DEFAULT 'approved' CHECK(commercial_use_status IN ('pending','approved','quarantined','rejected'));
ALTER TABLE gutenberg_source_cache ADD COLUMN trademark_cleanup_required integer NOT NULL DEFAULT 0 CHECK(trademark_cleanup_required IN (0,1));
ALTER TABLE gutenberg_source_cache ADD COLUMN canonicalization_version text NOT NULL DEFAULT '';
ALTER TABLE gutenberg_source_cache ADD COLUMN source_metadata_json text NOT NULL DEFAULT '{}';
ALTER TABLE gutenberg_source_cache ADD COLUMN content_hash text NOT NULL DEFAULT '';
UPDATE gutenberg_source_cache SET source_item_id=id WHERE source_item_id='';
CREATE UNIQUE INDEX idx_gutenberg_source_item ON gutenberg_source_cache(source_id,source_item_id);
CREATE INDEX idx_gutenberg_source_cache_source_status ON gutenberg_source_cache(source_id,ingest_status,rights_status,commercial_use_status);
CREATE INDEX idx_gutenberg_source_cache_rights_queue ON gutenberg_source_cache(rights_status,commercial_use_status,epub_status);

CREATE TABLE gutenberg_rights_evidence (
  id text PRIMARY KEY,
  source_id text NOT NULL REFERENCES gutenberg_sources(id) ON DELETE RESTRICT,
  cache_id text NOT NULL REFERENCES gutenberg_source_cache(id) ON DELETE RESTRICT,
  source_item_id text NOT NULL,
  determination text NOT NULL CHECK(determination IN ('public-domain','permission','not-public-domain','unknown')),
  territory_code text NOT NULL REFERENCES territories(code) ON DELETE RESTRICT,
  evidence_url text NOT NULL,
  evidence_type text NOT NULL CHECK(evidence_type IN ('source-catalog','item-header','signed-manifest','operator-review')),
  evidence_hash text NOT NULL,
  parser_version text NOT NULL,
  status text NOT NULL CHECK(status IN ('approved','rejected','superseded')),
  checked_at text NOT NULL,
  created_at text NOT NULL
);
CREATE INDEX idx_gutenberg_evidence_item ON gutenberg_rights_evidence(source_id,source_item_id,status,territory_code);
CREATE INDEX idx_gutenberg_evidence_cache ON gutenberg_rights_evidence(cache_id,status);
CREATE TRIGGER gutenberg_evidence_no_update BEFORE UPDATE ON gutenberg_rights_evidence BEGIN
  SELECT RAISE(ABORT,'Gutenberg rights evidence is append-only; supersede with a new record');
END;
CREATE TRIGGER gutenberg_evidence_no_delete BEFORE DELETE ON gutenberg_rights_evidence BEGIN
  SELECT RAISE(ABORT,'Gutenberg rights evidence is append-only');
END;

CREATE TABLE gutenberg_ingest_runs (
  id text PRIMARY KEY,
  source_id text NOT NULL REFERENCES gutenberg_sources(id) ON DELETE RESTRICT,
  started_at text NOT NULL,
  completed_at text,
  status text NOT NULL CHECK(status IN ('running','succeeded','partial','failed','not-modified')),
  cursor_before text,
  cursor_after text,
  fetched_count integer NOT NULL DEFAULT 0,
  accepted_count integer NOT NULL DEFAULT 0,
  quarantined_count integer NOT NULL DEFAULT 0,
  error text NOT NULL DEFAULT '',
  response_etag text,
  response_last_modified text,
  response_hash text NOT NULL DEFAULT ''
);
CREATE INDEX idx_gutenberg_ingest_runs_source ON gutenberg_ingest_runs(source_id,started_at DESC);
CREATE TRIGGER gutenberg_ingest_runs_no_delete BEFORE DELETE ON gutenberg_ingest_runs BEGIN
  SELECT RAISE(ABORT,'ingestion audit is append-only');
END;

ALTER TABLE rights_grants ADD COLUMN source_evidence_id text;
ALTER TABLE rights_decisions ADD COLUMN source_evidence_id text;
CREATE INDEX idx_rights_grants_source_evidence ON rights_grants(source_evidence_id);
CREATE INDEX idx_rights_decisions_source_evidence ON rights_decisions(source_evidence_id);
CREATE TRIGGER gutenberg_rights_require_evidence BEFORE INSERT ON rights_grants
WHEN NEW.license_type='public-domain' AND NEW.source LIKE 'gutenberg-%' AND NEW.source_evidence_id IS NULL
BEGIN
  SELECT RAISE(ABORT,'Gutenberg public-domain grants require source evidence');
END;
CREATE TRIGGER gutenberg_rights_validate_evidence BEFORE INSERT ON rights_grants
WHEN NEW.source_evidence_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM gutenberg_rights_evidence ge
  JOIN gutenberg_source_cache gc ON gc.id=ge.cache_id AND gc.source_id=ge.source_id AND gc.source_item_id=ge.source_item_id
  JOIN products p ON p.source_name='gutenberg' AND p.source_external_id=gc.id AND p.edition_id=NEW.edition_id
  WHERE ge.id=NEW.source_evidence_id AND ge.status='approved' AND ge.determination='public-domain'
    AND upper(ge.territory_code)=upper(NEW.territory_code)
    AND (NEW.source NOT LIKE 'gutenberg-pg_%' OR NEW.source='gutenberg-'||ge.source_id||'-public-domain')
)
BEGIN
  SELECT RAISE(ABORT,'rights grant does not match approved source evidence');
END;

INSERT OR IGNORE INTO publishers(id,name,website,created_at,updated_at) VALUES
('pub_project_gutenberg_canada','Project Gutenberg Canada','https://www.gutenberg.ca/',datetime('now'),datetime('now')),
('pub_project_gutenberg_australia','Project Gutenberg Australia','https://gutenberg.net.au/',datetime('now'),datetime('now')),
('pub_project_gutenberg_europe','Project Gutenberg Europe','https://rastko.net/showrss.php?id=ge',datetime('now'),datetime('now'));

INSERT INTO gutenberg_sources(id,code,name,homepage_url,catalog_url,license_url,publisher_id,identifier_scheme,jurisdiction_mode,default_territory_code,feed_kind,enabled,priority,refresh_seconds,max_items_per_run,rights_policy,commercial_policy,trademark_cleanup_required,created_at,updated_at) VALUES
('pg_us','PGUS','Project Gutenberg','https://www.gutenberg.org/','https://gutendex.com/books/?copyright=false&mime_type=application%2Fepub%2Bzip','https://www.gutenberg.org/policy/license.html','pub_project_gutenberg','gutenberg','single-territory','US','gutendex-json',1,10,86400,250,'US public-domain determination; never infer foreign availability','canonicalize-before-retail',0,datetime('now'),datetime('now')),
('pg_ca','PGCA','Project Gutenberg Canada','https://www.gutenberg.ca/','https://www.gutenberg.ca/index.html','https://www.gutenberg.ca/links/licence.html','pub_project_gutenberg_canada','gutenberg-canada','single-territory','CA','html-catalog',1,20,86400,500,'Source catalog asserts Canadian public-domain status; permission-only exceptions must be quarantined','canonicalize-and-strip-source-branding',1,datetime('now'),datetime('now')),
('pg_au','PGAU','Project Gutenberg Australia','https://gutenberg.net.au/','https://www.gutenberg.net.au/plusfifty.html','https://gutenberg.net.au/licence.html','pub_project_gutenberg_australia','gutenberg-australia','single-territory','AU','html-catalog',1,30,86400,500,'Source catalog is jurisdiction-specific to Australia; copyright/permission exceptions must be quarantined','canonicalize-and-strip-source-branding',1,datetime('now'),datetime('now')),
('pg_eu','PGEU','Project Gutenberg Europe','https://rastko.net/showrss.php?id=ge','https://rastko.net/showrss.php?id=ge','https://www.gutenberg.org/help/faq.html','pub_project_gutenberg_europe','gutenberg-europe','per-item-territories',NULL,'rights-manifest',1,40,86400,250,'No blanket Europe grant: every item requires explicit country-level evidence from a trusted manifest/operator review','country-scoped-manifest-required',1,datetime('now'),datetime('now'));

INSERT OR IGNORE INTO gutenberg_source_states(source_id,status,last_error,attempts,total_catalog_count,seen_count,accepted_count,quarantined_count,updated_at)
SELECT id,'idle','',0,0,0,0,0,datetime('now') FROM gutenberg_sources;

-- Existing US staging rows and grants remain valid, but add evidence for future audits and bind
-- old US grants to it where possible. The US cache already came from Gutendex copyright=false.
UPDATE gutenberg_source_cache SET
  source_id='pg_us',source_item_id=id,source_project='Project Gutenberg',
  source_license_url='https://www.gutenberg.org/policy/license.html',rights_status=CASE WHEN copyright=0 THEN 'public-domain' ELSE 'rejected' END,
  rights_territories_json=CASE WHEN copyright=0 THEN '["US"]' ELSE '[]' END,
  rights_evidence_url=source_url,rights_checked_at=COALESCE(rights_checked_at,updated_at),commercial_use_status=CASE WHEN copyright=0 THEN 'approved' ELSE 'rejected' END,
  trademark_cleanup_required=0,canonicalization_version='legacy-pgus-v1'
WHERE source_id='pg_us';

INSERT OR IGNORE INTO gutenberg_rights_evidence(id,source_id,cache_id,source_item_id,determination,territory_code,evidence_url,evidence_type,evidence_hash,parser_version,status,checked_at,created_at)
SELECT 'gre_pgus_us_'||id,'pg_us',id,id,'public-domain','US',source_url,'source-catalog','legacy:'||id,'legacy-pgus-v1','approved',COALESCE(updated_at,datetime('now')),COALESCE(first_ingested_at,datetime('now'))
FROM gutenberg_source_cache WHERE source_id='pg_us' AND copyright=0;
UPDATE gutenberg_source_cache SET rights_evidence_id='gre_pgus_us_'||id WHERE source_id='pg_us' AND copyright=0;
UPDATE rights_grants SET source_evidence_id='gre_pgus_us_'||substr(id,length('right_gutenberg_us_')+1)
WHERE id LIKE 'right_gutenberg_us_%' AND source_evidence_id IS NULL
  AND EXISTS(SELECT 1 FROM gutenberg_rights_evidence ge WHERE ge.id='gre_pgus_us_'||substr(rights_grants.id,length('right_gutenberg_us_')+1));

-- Revalidate provenance whenever a source-derived grant's legal scope/evidence changes.
CREATE TRIGGER gutenberg_rights_require_evidence_update BEFORE UPDATE OF license_type,source,source_evidence_id ON rights_grants
WHEN NEW.license_type='public-domain' AND NEW.source LIKE 'gutenberg-%' AND NEW.source_evidence_id IS NULL
BEGIN
  SELECT RAISE(ABORT,'Gutenberg public-domain grants require source evidence');
END;
CREATE TRIGGER gutenberg_rights_validate_evidence_update BEFORE UPDATE OF source_evidence_id,territory_code,license_type,source ON rights_grants
WHEN NEW.source_evidence_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM gutenberg_rights_evidence ge
  JOIN gutenberg_source_cache gc ON gc.id=ge.cache_id AND gc.source_id=ge.source_id AND gc.source_item_id=ge.source_item_id
  JOIN products p ON p.source_name='gutenberg' AND p.source_external_id=gc.id AND p.edition_id=NEW.edition_id
  WHERE ge.id=NEW.source_evidence_id AND ge.status='approved' AND ge.determination='public-domain'
    AND upper(ge.territory_code)=upper(NEW.territory_code)
    AND (NEW.source NOT LIKE 'gutenberg-pg_%' OR NEW.source='gutenberg-'||ge.source_id||'-public-domain')
)
BEGIN
  SELECT RAISE(ABORT,'rights grant does not match approved source evidence');
END;

-- A regional source row cannot remain sellable after its legal/commercial verification is lost.
-- This is database-level defense in depth so operator scripts and future workers fail closed too.
CREATE TRIGGER gutenberg_regional_cache_fail_closed AFTER UPDATE OF rights_status,commercial_use_status,ingest_status ON gutenberg_source_cache
WHEN NEW.source_id<>'pg_us' AND (NEW.rights_status<>'public-domain' OR NEW.commercial_use_status<>'approved' OR NEW.ingest_status<>'active')
BEGIN
  UPDATE products SET storefront_status='inactive',updated_at=datetime('now')
    WHERE source_name='gutenberg' AND source_external_id=NEW.id;
  UPDATE offers SET active=0,updated_at=datetime('now')
    WHERE product_id IN (SELECT id FROM products WHERE source_name='gutenberg' AND source_external_id=NEW.id);
  UPDATE editions SET release_status='unavailable',updated_at=datetime('now')
    WHERE id IN (SELECT edition_id FROM products WHERE source_name='gutenberg' AND source_external_id=NEW.id);
  UPDATE rights_grants SET status='suspended',updated_at=datetime('now')
    WHERE source='gutenberg-'||NEW.source_id||'-public-domain'
      AND edition_id IN (SELECT edition_id FROM products WHERE source_name='gutenberg' AND source_external_id=NEW.id)
      AND status='active';
END;


-- Include source evidence in the immutable rights audit snapshot. 0016 predates this column.
DROP TRIGGER IF EXISTS rights_grants_audit_insert;
DROP TRIGGER IF EXISTS rights_grants_audit_update;
CREATE TRIGGER rights_grants_audit_insert AFTER INSERT ON rights_grants BEGIN
  INSERT INTO rights_grant_audit(id,grant_id,action,snapshot_json,recorded_at) VALUES(
    'rga_'||lower(hex(randomblob(16))),NEW.id,'insert',json_object(
      'editionId',NEW.edition_id,'rightsholderId',NEW.rightsholder_id,'rightsholderPartyId',NEW.rightsholder_party_id,
      'territory',NEW.territory_code,'scopeSummary',NEW.scope_summary,'format',NEW.format,'salesChannel',NEW.sales_channel,'startsAt',NEW.starts_at,'endsAt',NEW.ends_at,
      'licenseType',NEW.license_type,'contractId',NEW.contract_id,'exclusivity',NEW.exclusivity,'drmRequirement',NEW.drm_requirement,
      'subscriptionPermitted',NEW.subscription_permitted,'libraryPermitted',NEW.library_permitted,'decision',NEW.decision,'status',NEW.status,
      'promotionRestrictions',CASE WHEN json_valid(NEW.promotion_restrictions_json) THEN json(NEW.promotion_restrictions_json) ELSE json('{}') END,
      'contractReference',NEW.contract_reference,'source',NEW.source,'sourceEvidenceId',NEW.source_evidence_id,'notes',NEW.notes
    ),COALESCE(NEW.updated_at,NEW.created_at));
END;
CREATE TRIGGER rights_grants_audit_update AFTER UPDATE ON rights_grants BEGIN
  INSERT INTO rights_grant_audit(id,grant_id,action,snapshot_json,recorded_at) VALUES(
    'rga_'||lower(hex(randomblob(16))),NEW.id,'update',json_object(
      'editionId',NEW.edition_id,'rightsholderId',NEW.rightsholder_id,'rightsholderPartyId',NEW.rightsholder_party_id,
      'territory',NEW.territory_code,'scopeSummary',NEW.scope_summary,'format',NEW.format,'salesChannel',NEW.sales_channel,'startsAt',NEW.starts_at,'endsAt',NEW.ends_at,
      'licenseType',NEW.license_type,'contractId',NEW.contract_id,'exclusivity',NEW.exclusivity,'drmRequirement',NEW.drm_requirement,
      'subscriptionPermitted',NEW.subscription_permitted,'libraryPermitted',NEW.library_permitted,'decision',NEW.decision,'status',NEW.status,
      'promotionRestrictions',CASE WHEN json_valid(NEW.promotion_restrictions_json) THEN json(NEW.promotion_restrictions_json) ELSE json('{}') END,
      'contractReference',NEW.contract_reference,'source',NEW.source,'sourceEvidenceId',NEW.source_evidence_id,'notes',NEW.notes
    ),COALESCE(NEW.updated_at,datetime('now')));
END;
