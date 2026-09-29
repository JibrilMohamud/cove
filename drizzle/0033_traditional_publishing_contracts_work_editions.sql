-- Traditional publisher infrastructure, versioned contract policy, and canonical Work/Edition distinctions.
-- This migration deliberately separates B2B ingestion state and contract policy from per-book merchandising flags.

-- ---------------------------------------------------------------------------
-- Traditional publisher / distributor partner integration
-- ---------------------------------------------------------------------------
CREATE TABLE publisher_partner_profiles (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES publishing_accounts(id) ON DELETE CASCADE,
  partner_code TEXT NOT NULL UNIQUE,
  partner_type TEXT NOT NULL DEFAULT 'publisher' CHECK(partner_type IN ('publisher','distributor','aggregator','agent')),
  integration_tier TEXT NOT NULL DEFAULT 'managed' CHECK(integration_tier IN ('managed','api','sftp','hybrid')),
  production_status TEXT NOT NULL DEFAULT 'not_started' CHECK(production_status IN ('not_started','testing','certification','active','paused','terminated')),
  sandbox_enabled INTEGER NOT NULL DEFAULT 1 CHECK(sandbox_enabled IN (0,1)),
  metadata_standard TEXT NOT NULL DEFAULT 'onix_3' CHECK(metadata_standard IN ('onix_3','onix_2_1','fore_json')),
  default_contract_id TEXT REFERENCES rights_contracts(id) ON DELETE SET NULL,
  operations_email TEXT NOT NULL DEFAULT '',
  technical_email TEXT NOT NULL DEFAULT '',
  acknowledgements_url TEXT NOT NULL DEFAULT '',
  webhook_url TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_partner_profiles_status ON publisher_partner_profiles(production_status,partner_type,partner_code);

-- Secrets are returned once at issuance. Only a digest and display prefix are persisted.
CREATE TABLE publisher_partner_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
  label TEXT NOT NULL,
  key_prefix TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '["feeds:write","feeds:read"]',
  ip_allowlist_json TEXT NOT NULL DEFAULT '[]',
  actor_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked','expired')),
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_partner_credentials_account ON publisher_partner_credentials(account_id,environment,status,created_at DESC);

CREATE TABLE publisher_ingestion_channels (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
  channel_type TEXT NOT NULL CHECK(channel_type IN ('api','sftp','object_drop')),
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','disabled')),
  metadata_format TEXT NOT NULL DEFAULT 'onix_3' CHECK(metadata_format IN ('onix_3','onix_2_1','fore_json')),
  -- Config contains non-secret values only (remote path, host alias, naming rules, etc.).
  config_json TEXT NOT NULL DEFAULT '{}',
  -- Points to a secret-manager record; never store passwords/private keys in Cove's catalog DB.
  secret_reference TEXT NOT NULL DEFAULT '',
  last_success_at TEXT,
  last_failure_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id,environment,label)
);
CREATE INDEX idx_partner_channels_account ON publisher_ingestion_channels(account_id,environment,status);

CREATE TABLE publisher_feed_submissions (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE RESTRICT,
  credential_id TEXT REFERENCES publisher_partner_credentials(id) ON DELETE SET NULL,
  channel_id TEXT REFERENCES publisher_ingestion_channels(id) ON DELETE SET NULL,
  environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
  feed_type TEXT NOT NULL CHECK(feed_type IN ('metadata','price','availability','territory','assets_manifest')),
  feed_format TEXT NOT NULL CHECK(feed_format IN ('onix_3','onix_2_1','fore_json')),
  mode TEXT NOT NULL DEFAULT 'delta' CHECK(mode IN ('full','delta')),
  replace_missing INTEGER NOT NULL DEFAULT 0 CHECK(replace_missing IN (0,1)),
  external_feed_id TEXT NOT NULL DEFAULT '',
  sequence_number INTEGER,
  source_filename TEXT NOT NULL DEFAULT '',
  source_sha256 TEXT NOT NULL,
  raw_object_key TEXT,
  status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','validating','accepted','accepted_with_warnings','rejected','applying','applied','partially_applied','failed')),
  item_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  applied_count INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL,
  validated_at TEXT,
  applied_at TEXT,
  UNIQUE(account_id,environment,feed_type,external_feed_id)
);
CREATE UNIQUE INDEX idx_partner_feed_checksum_idempotency ON publisher_feed_submissions(account_id,environment,feed_type,source_sha256,mode);
CREATE INDEX idx_partner_feed_queue ON publisher_feed_submissions(environment,status,received_at);
CREATE INDEX idx_partner_feed_account ON publisher_feed_submissions(account_id,environment,received_at DESC);

CREATE TABLE publisher_feed_items (
  id TEXT PRIMARY KEY NOT NULL,
  submission_id TEXT NOT NULL REFERENCES publisher_feed_submissions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  partner_product_key TEXT NOT NULL,
  notification_type TEXT NOT NULL DEFAULT 'update',
  normalized_json TEXT NOT NULL,
  source_fragment_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','valid','warning','rejected','applied','skipped')),
  validation_json TEXT NOT NULL DEFAULT '[]',
  applied_entity_type TEXT NOT NULL DEFAULT '',
  applied_entity_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(submission_id,ordinal)
);
CREATE INDEX idx_partner_feed_items_submission ON publisher_feed_items(submission_id,status,ordinal);
CREATE INDEX idx_partner_feed_items_key ON publisher_feed_items(partner_product_key,submission_id);

CREATE TABLE publisher_feed_assets (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE RESTRICT,
  environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
  submission_id TEXT REFERENCES publisher_feed_submissions(id) ON DELETE SET NULL,
  partner_product_key TEXT NOT NULL,
  asset_kind TEXT NOT NULL CHECK(asset_kind IN ('epub','cover','audio','sample','supplement')),
  source_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  object_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'quarantined' CHECK(status IN ('quarantined','linked','validating','accepted','rejected')),
  linked_publishing_asset_version_id TEXT REFERENCES publishing_asset_versions(id) ON DELETE SET NULL,
  validation_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_partner_feed_assets_link ON publisher_feed_assets(account_id,environment,partner_product_key,asset_kind,status);
CREATE INDEX idx_partner_feed_assets_hash ON publisher_feed_assets(sha256,asset_kind);

-- Asset manifests are durable expectations used by SFTP/object-drop and API bulk flows.
-- The manifest may arrive before or after the binary; matching is by product/kind and
-- checksum so filenames are not trusted as integrity evidence.
CREATE TABLE publisher_asset_expectations (
  id TEXT PRIMARY KEY NOT NULL,
  submission_id TEXT NOT NULL REFERENCES publisher_feed_submissions(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE RESTRICT,
  environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
  partner_product_key TEXT NOT NULL,
  asset_kind TEXT NOT NULL CHECK(asset_kind IN ('epub','cover','audio','sample','supplement')),
  source_filename TEXT NOT NULL,
  expected_mime_type TEXT NOT NULL DEFAULT '',
  expected_size_bytes INTEGER CHECK(expected_size_bytes IS NULL OR expected_size_bytes>=0),
  expected_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','matched','mismatch','cancelled')),
  matched_asset_id TEXT REFERENCES publisher_feed_assets(id) ON DELETE SET NULL,
  validation_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  matched_at TEXT,
  UNIQUE(submission_id,partner_product_key,asset_kind,source_filename)
);
CREATE INDEX idx_partner_asset_expectation_match ON publisher_asset_expectations(account_id,environment,partner_product_key,asset_kind,status);
CREATE INDEX idx_partner_asset_expectation_hash ON publisher_asset_expectations(expected_sha256,status);

CREATE TABLE publisher_validation_responses (
  id TEXT PRIMARY KEY NOT NULL,
  submission_id TEXT NOT NULL REFERENCES publisher_feed_submissions(id) ON DELETE CASCADE,
  response_type TEXT NOT NULL CHECK(response_type IN ('receipt','validation','application','error')),
  status TEXT NOT NULL,
  machine_code TEXT NOT NULL,
  message TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK(delivery_status IN ('pending','delivered','failed','not_configured')),
  attempts INTEGER NOT NULL DEFAULT 0,
  destination_url TEXT NOT NULL DEFAULT '',
  payload_sha256 TEXT NOT NULL DEFAULT '',
  last_attempt_at TEXT,
  next_attempt_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX idx_partner_validation_responses_submission ON publisher_validation_responses(submission_id,created_at);
CREATE INDEX idx_partner_validation_delivery ON publisher_validation_responses(delivery_status,next_attempt_at,created_at);

CREATE TABLE publisher_feed_cursors (
  account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
  feed_type TEXT NOT NULL,
  last_sequence_number INTEGER,
  last_external_feed_id TEXT NOT NULL DEFAULT '',
  last_source_sha256 TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(account_id,environment,feed_type)
);

CREATE TABLE publisher_catalog_mappings (
  account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
  partner_product_key TEXT NOT NULL,
  publishing_title_id TEXT REFERENCES publishing_titles(id) ON DELETE SET NULL,
  publishing_edition_id TEXT REFERENCES publishing_edition_drafts(id) ON DELETE SET NULL,
  catalog_work_id TEXT REFERENCES works(id) ON DELETE SET NULL,
  catalog_edition_id TEXT REFERENCES editions(id) ON DELETE SET NULL,
  catalog_product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  partner_record_reference TEXT NOT NULL DEFAULT '',
  work_reference TEXT NOT NULL DEFAULT '',
  original_work_title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleted','withdrawn','superseded')),
  source_revision TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(account_id,environment,partner_product_key)
);
CREATE INDEX idx_partner_mapping_catalog ON publisher_catalog_mappings(catalog_product_id,catalog_edition_id,catalog_work_id);

CREATE TABLE publisher_partner_audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE CASCADE,
  environment TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user','credential','worker','system','staff')),
  actor_id TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL,
  subject_type TEXT NOT NULL DEFAULT '',
  subject_id TEXT NOT NULL DEFAULT '',
  event_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_partner_audit_account ON publisher_partner_audit_events(account_id,created_at DESC);

-- ---------------------------------------------------------------------------
-- Versioned retailer contracts. Rights grants reference these versions; the
-- policy applies before any per-edition rights grant can authorize a sale.
-- ---------------------------------------------------------------------------
CREATE TABLE rights_contract_versions (
  id TEXT PRIMARY KEY NOT NULL,
  contract_id TEXT NOT NULL REFERENCES rights_contracts(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK(version_number>=1),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','superseded','terminated')),
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  retailer_commission_bps INTEGER NOT NULL CHECK(retailer_commission_bps BETWEEN 0 AND 10000),
  payment_schedule_json TEXT NOT NULL DEFAULT '{"cadence":"monthly","netDays":30}',
  returns_policy_json TEXT NOT NULL DEFAULT '{"customerWindowDays":14,"publisherChargeback":true}',
  subscription_terms_json TEXT NOT NULL DEFAULT '{"permitted":false}',
  marketing_permissions_json TEXT NOT NULL DEFAULT '{}',
  drm_requirements_json TEXT NOT NULL DEFAULT '{}',
  delivery_rules_json TEXT NOT NULL DEFAULT '{}',
  termination_policy_json TEXT NOT NULL DEFAULT '{}',
  post_termination_access_policy TEXT NOT NULL DEFAULT 'preserve_perpetual_purchases' CHECK(post_termination_access_policy IN ('preserve_perpetual_purchases','preserve_downloaded_only','block_future_downloads','revoke_all')),
  document_sha256 TEXT NOT NULL DEFAULT '',
  source_document_object_key TEXT,
  approved_by_user_id TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(contract_id,version_number)
);
CREATE INDEX idx_contract_versions_active ON rights_contract_versions(contract_id,status,effective_from,effective_to);

-- Economic/legal terms become immutable when a version leaves draft. The only
-- mutable fields after activation are lifecycle status/effective_to so a later
-- version can close and supersede the previous window without rewriting terms.
CREATE TRIGGER trg_rights_contract_version_terms_immutable
BEFORE UPDATE ON rights_contract_versions
WHEN OLD.status <> 'draft' AND (
  NEW.contract_id <> OLD.contract_id OR NEW.version_number <> OLD.version_number OR NEW.effective_from <> OLD.effective_from OR
  NEW.retailer_commission_bps <> OLD.retailer_commission_bps OR NEW.payment_schedule_json <> OLD.payment_schedule_json OR
  NEW.returns_policy_json <> OLD.returns_policy_json OR NEW.subscription_terms_json <> OLD.subscription_terms_json OR
  NEW.marketing_permissions_json <> OLD.marketing_permissions_json OR NEW.drm_requirements_json <> OLD.drm_requirements_json OR
  NEW.delivery_rules_json <> OLD.delivery_rules_json OR NEW.termination_policy_json <> OLD.termination_policy_json OR
  NEW.post_termination_access_policy <> OLD.post_termination_access_policy OR NEW.document_sha256 <> OLD.document_sha256 OR
  COALESCE(NEW.source_document_object_key,'') <> COALESCE(OLD.source_document_object_key,'')
)
BEGIN SELECT RAISE(ABORT,'Activated contract terms are immutable; create a new version'); END;

CREATE TRIGGER trg_rights_contract_version_no_delete
BEFORE DELETE ON rights_contract_versions
WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT,'Activated contract versions cannot be deleted'); END;

CREATE TABLE rights_contract_version_territories (
  contract_version_id TEXT NOT NULL REFERENCES rights_contract_versions(id) ON DELETE CASCADE,
  territory_code TEXT NOT NULL REFERENCES territories(code) ON DELETE RESTRICT,
  decision TEXT NOT NULL DEFAULT 'allow' CHECK(decision IN ('allow','deny')),
  PRIMARY KEY(contract_version_id,territory_code)
);
CREATE INDEX idx_contract_version_territories_lookup ON rights_contract_version_territories(territory_code,contract_version_id,decision);

CREATE TABLE rights_contract_version_formats (
  contract_version_id TEXT NOT NULL REFERENCES rights_contract_versions(id) ON DELETE CASCADE,
  format TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'allow' CHECK(decision IN ('allow','deny')),
  drm_requirement TEXT NOT NULL DEFAULT 'none',
  download_limit INTEGER,
  device_limit INTEGER,
  offline_permitted INTEGER NOT NULL DEFAULT 1 CHECK(offline_permitted IN (0,1)),
  PRIMARY KEY(contract_version_id,format)
);

CREATE TABLE rights_contract_version_channels (
  contract_version_id TEXT NOT NULL REFERENCES rights_contract_versions(id) ON DELETE CASCADE,
  sales_channel TEXT NOT NULL CHECK(sales_channel IN ('retail','subscription','library')),
  permitted INTEGER NOT NULL DEFAULT 1 CHECK(permitted IN (0,1)),
  terms_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(contract_version_id,sales_channel)
);

-- Version child policy is also immutable once the parent leaves draft.
CREATE TRIGGER trg_contract_territory_locked_insert BEFORE INSERT ON rights_contract_version_territories
WHEN (SELECT status FROM rights_contract_versions WHERE id=NEW.contract_version_id) <> 'draft'
BEGIN SELECT RAISE(ABORT,'Activated contract territory policy is immutable'); END;
CREATE TRIGGER trg_contract_territory_locked_update BEFORE UPDATE ON rights_contract_version_territories
WHEN (SELECT status FROM rights_contract_versions WHERE id=OLD.contract_version_id) <> 'draft'
BEGIN SELECT RAISE(ABORT,'Activated contract territory policy is immutable'); END;
CREATE TRIGGER trg_contract_territory_locked_delete BEFORE DELETE ON rights_contract_version_territories
WHEN (SELECT status FROM rights_contract_versions WHERE id=OLD.contract_version_id) <> 'draft'
BEGIN SELECT RAISE(ABORT,'Activated contract territory policy is immutable'); END;

CREATE TRIGGER trg_contract_format_locked_insert BEFORE INSERT ON rights_contract_version_formats
WHEN (SELECT status FROM rights_contract_versions WHERE id=NEW.contract_version_id) <> 'draft'
BEGIN SELECT RAISE(ABORT,'Activated contract format policy is immutable'); END;
CREATE TRIGGER trg_contract_format_locked_update BEFORE UPDATE ON rights_contract_version_formats
WHEN (SELECT status FROM rights_contract_versions WHERE id=OLD.contract_version_id) <> 'draft'
BEGIN SELECT RAISE(ABORT,'Activated contract format policy is immutable'); END;
CREATE TRIGGER trg_contract_format_locked_delete BEFORE DELETE ON rights_contract_version_formats
WHEN (SELECT status FROM rights_contract_versions WHERE id=OLD.contract_version_id) <> 'draft'
BEGIN SELECT RAISE(ABORT,'Activated contract format policy is immutable'); END;

CREATE TRIGGER trg_contract_channel_locked_insert BEFORE INSERT ON rights_contract_version_channels
WHEN (SELECT status FROM rights_contract_versions WHERE id=NEW.contract_version_id) <> 'draft'
BEGIN SELECT RAISE(ABORT,'Activated contract channel policy is immutable'); END;
CREATE TRIGGER trg_contract_channel_locked_update BEFORE UPDATE ON rights_contract_version_channels
WHEN (SELECT status FROM rights_contract_versions WHERE id=OLD.contract_version_id) <> 'draft'
BEGIN SELECT RAISE(ABORT,'Activated contract channel policy is immutable'); END;
CREATE TRIGGER trg_contract_channel_locked_delete BEFORE DELETE ON rights_contract_version_channels
WHEN (SELECT status FROM rights_contract_versions WHERE id=OLD.contract_version_id) <> 'draft'
BEGIN SELECT RAISE(ABORT,'Activated contract channel policy is immutable'); END;

CREATE TABLE publisher_contract_assignments (
  account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE CASCADE,
  contract_id TEXT NOT NULL REFERENCES rights_contracts(id) ON DELETE RESTRICT,
  relationship TEXT NOT NULL DEFAULT 'direct' CHECK(relationship IN ('direct','distributor','aggregator','agent')),
  starts_at TEXT,
  ends_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','terminated')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(account_id,contract_id)
);

CREATE TABLE rights_contract_audit (
  id TEXT PRIMARY KEY NOT NULL,
  contract_id TEXT NOT NULL REFERENCES rights_contracts(id) ON DELETE CASCADE,
  contract_version_id TEXT REFERENCES rights_contract_versions(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  actor_user_id TEXT NOT NULL DEFAULT '',
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_contract_audit_contract ON rights_contract_audit(contract_id,created_at DESC);

ALTER TABLE rights_grants ADD COLUMN contract_version_id TEXT REFERENCES rights_contract_versions(id) ON DELETE RESTRICT;
ALTER TABLE rights_decisions ADD COLUMN contract_version_id TEXT;
ALTER TABLE rights_decisions ADD COLUMN contract_policy_json TEXT NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------
-- Canonical Work page + differentiated Edition policy.
-- ---------------------------------------------------------------------------
ALTER TABLE works ADD COLUMN work_type TEXT NOT NULL DEFAULT 'original';
ALTER TABLE works ADD COLUMN canonical_status TEXT NOT NULL DEFAULT 'canonical';
ALTER TABLE editions ADD COLUMN edition_type TEXT NOT NULL DEFAULT 'original';
ALTER TABLE editions ADD COLUMN differentiation_status TEXT NOT NULL DEFAULT 'not_required';
ALTER TABLE editions ADD COLUMN differentiation_summary TEXT NOT NULL DEFAULT '';
ALTER TABLE editions ADD COLUMN canonical_public_domain INTEGER NOT NULL DEFAULT 0;

CREATE TABLE work_identity_keys (
  identity_key TEXT PRIMARY KEY NOT NULL,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  scheme TEXT NOT NULL DEFAULT 'title_author_language',
  confidence REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_work_identity_work ON work_identity_keys(work_id,scheme);

CREATE TABLE work_redirects (
  old_work_id TEXT PRIMARY KEY NOT NULL,
  canonical_work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_work_redirect_target ON work_redirects(canonical_work_id);

CREATE TABLE edition_distinctions (
  edition_id TEXT PRIMARY KEY NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  edition_type TEXT NOT NULL CHECK(edition_type IN ('canonical_public_domain','annotated','new_translation','illustrated','scholarly','commercial_audiobook','original')),
  differentiation_summary TEXT NOT NULL DEFAULT '',
  translator_contributor_id TEXT REFERENCES contributors(id) ON DELETE SET NULL,
  substantive_features_json TEXT NOT NULL DEFAULT '[]',
  source_text_fingerprint TEXT NOT NULL DEFAULT '',
  asset_sha256 TEXT NOT NULL DEFAULT '',
  verification_status TEXT NOT NULL DEFAULT 'pending' CHECK(verification_status IN ('pending','verified','rejected','not_required')),
  verified_by_user_id TEXT,
  verified_at TEXT,
  policy_version TEXT NOT NULL DEFAULT 'fore-public-domain-editions-v1',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_edition_distinction_type ON edition_distinctions(edition_type,verification_status);
CREATE INDEX idx_edition_distinction_hash ON edition_distinctions(asset_sha256,edition_type);

CREATE TABLE public_domain_policy_versions (
  id TEXT PRIMARY KEY NOT NULL,
  version TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('draft','active','retired')),
  canonical_source_policy_json TEXT NOT NULL,
  differentiation_policy_json TEXT NOT NULL,
  duplicate_policy_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT
);

CREATE TABLE edition_duplicate_policy_decisions (
  id TEXT PRIMARY KEY NOT NULL,
  edition_id TEXT NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  matched_edition_id TEXT REFERENCES editions(id) ON DELETE SET NULL,
  policy_version TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('allow','review','reject')),
  reason_code TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  decided_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_edition_duplicate_policy ON edition_duplicate_policy_decisions(edition_id,created_at DESC);

-- Draft-side classification allows self-publishing and partner feeds to declare
-- the edition distinction before materialization to the public catalog.
ALTER TABLE publishing_edition_drafts ADD COLUMN edition_type TEXT NOT NULL DEFAULT 'original';
ALTER TABLE publishing_edition_drafts ADD COLUMN differentiation_summary TEXT NOT NULL DEFAULT '';
ALTER TABLE publishing_edition_drafts ADD COLUMN contract_id TEXT REFERENCES rights_contracts(id) ON DELETE SET NULL;
ALTER TABLE publishing_edition_drafts ADD COLUMN contract_version_id TEXT REFERENCES rights_contract_versions(id) ON DELETE SET NULL;

INSERT INTO public_domain_policy_versions(id,version,status,canonical_source_policy_json,differentiation_policy_json,duplicate_policy_json,created_at,activated_at)
VALUES(
  'pdpolicy_v1','fore-public-domain-editions-v1','active',
  '{"preferredCanonicalSources":["gutenberg"],"oneCanonicalFreeEditionPerWork":true,"canonicalPriceMinor":0}',
  '{"allowedTypes":["annotated","new_translation","illustrated","scholarly","commercial_audiobook"],"requireSummary":true,"newTranslationRequiresTranslator":true}',
  '{"rejectIdenticalCommercialPublicDomainEpub":true,"groupByCanonicalWork":true,"identicalAssetHashIsDuplicate":true}',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
);
