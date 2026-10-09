-- Cove Publishing: creator onboarding, payout/tax readiness, title staging,
-- quarantined assets, validation orchestration, immutable submissions and catalog materialization.

CREATE TABLE publishing_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  account_type TEXT NOT NULL CHECK(account_type IN ('person','company')),
  legal_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  country_code TEXT NOT NULL,
  contact_email TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','restricted','suspended','closed')),
  identity_status TEXT NOT NULL DEFAULT 'not_started' CHECK(identity_status IN ('not_started','pending','verified','failed','expired','manual_review')),
  tax_status TEXT NOT NULL DEFAULT 'not_started' CHECK(tax_status IN ('not_started','pending','verified','failed','expired','manual_review')),
  payout_status TEXT NOT NULL DEFAULT 'not_started' CHECK(payout_status IN ('not_started','pending','verified','restricted','failed')),
  terms_version TEXT NOT NULL DEFAULT '',
  terms_accepted_at TEXT,
  publisher_id TEXT REFERENCES publishers(id) ON DELETE SET NULL,
  finance_party_id TEXT REFERENCES finance_parties(id) ON DELETE SET NULL,
  rights_party_id TEXT REFERENCES rights_parties(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_publishing_accounts_status ON publishing_accounts(status,identity_status,tax_status,payout_status);
CREATE INDEX idx_publishing_accounts_publisher ON publishing_accounts(publisher_id);

CREATE TABLE publishing_account_members (
  account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','editor','finance','analyst')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('invited','active','suspended','removed')),
  invited_email TEXT NOT NULL DEFAULT '',
  invited_by_user_id TEXT,
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(account_id,user_id)
);
CREATE INDEX idx_publishing_members_user ON publishing_account_members(user_id,status,account_id);

CREATE TABLE publishing_addresses (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE CASCADE,
  address_type TEXT NOT NULL CHECK(address_type IN ('legal','mailing','tax')),
  line1 TEXT NOT NULL,
  line2 TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL DEFAULT '',
  country_code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id,address_type)
);

CREATE TABLE publishing_pen_names (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  sort_name TEXT NOT NULL DEFAULT '',
  contributor_id TEXT REFERENCES contributors(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id,display_name)
);

-- Never store raw identity documents here. provider_reference points to a PCI/KYC-capable vendor.
CREATE TABLE publishing_identity_verifications (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_reference TEXT NOT NULL DEFAULT '',
  verification_type TEXT NOT NULL DEFAULT 'government_id',
  status TEXT NOT NULL CHECK(status IN ('pending','verified','failed','expired','manual_review')),
  country_code TEXT NOT NULL,
  legal_name_snapshot TEXT NOT NULL,
  reason_code TEXT NOT NULL DEFAULT '',
  initiated_at TEXT NOT NULL,
  decided_at TEXT,
  expires_at TEXT,
  evidence_digest TEXT NOT NULL DEFAULT '',
  UNIQUE(provider,provider_reference)
);
CREATE INDEX idx_publishing_identity_account ON publishing_identity_verifications(account_id,initiated_at DESC);

-- Tax profiles hold statuses/rates and provider references only; raw TINs/forms remain with the tax provider.
CREATE TABLE publishing_tax_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE CASCADE,
  country_code TEXT NOT NULL,
  tax_classification TEXT NOT NULL DEFAULT '',
  form_type TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  provider_reference TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('pending','verified','failed','expired','manual_review')),
  withholding_bps INTEGER NOT NULL DEFAULT 0 CHECK(withholding_bps BETWEEN 0 AND 10000),
  treaty_country_code TEXT,
  valid_from TEXT,
  expires_at TEXT,
  validated_at TEXT,
  reason_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_publishing_tax_account ON publishing_tax_profiles(account_id,status,updated_at DESC);

-- Bank credentials are tokenized by the payout provider. Cove stores only display-safe metadata.
CREATE TABLE publishing_payout_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT 'eft' CHECK(method IN ('eft','ach','sepa','wire','other')),
  bank_country_code TEXT NOT NULL,
  payout_currency TEXT NOT NULL,
  account_last4 TEXT NOT NULL DEFAULT '',
  account_holder_type TEXT NOT NULL DEFAULT 'unknown' CHECK(account_holder_type IN ('individual','company','unknown')),
  status TEXT NOT NULL CHECK(status IN ('pending','verified','restricted','failed')),
  payout_threshold_minor INTEGER NOT NULL DEFAULT 5000,
  requirements_due_json TEXT NOT NULL DEFAULT '[]',
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider,provider_account_id)
);
CREATE INDEX idx_publishing_payout_account ON publishing_payout_accounts(account_id,status,updated_at DESC);

CREATE TABLE publishing_titles (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'en',
  audience TEXT NOT NULL DEFAULT 'general' CHECK(audience IN ('children','young_adult','general','academic','professional')),
  publisher_name TEXT NOT NULL DEFAULT '',
  imprint_name TEXT NOT NULL DEFAULT '',
  series_name TEXT NOT NULL DEFAULT '',
  series_relationship TEXT NOT NULL DEFAULT 'main' CHECK(series_relationship IN ('main','prequel','novella','companion','boxset','related')),
  series_position REAL,
  categories_json TEXT NOT NULL DEFAULT '[]',
  keywords_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','in_review','published','archived')),
  catalog_work_id TEXT REFERENCES works(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_publishing_titles_account ON publishing_titles(account_id,updated_at DESC);

CREATE TABLE publishing_edition_drafts (
  id TEXT PRIMARY KEY NOT NULL,
  title_id TEXT NOT NULL REFERENCES publishing_titles(id) ON DELETE CASCADE,
  format TEXT NOT NULL DEFAULT 'ebook' CHECK(format IN ('ebook','audiobook')),
  edition_label TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'en',
  isbn13 TEXT,
  publisher_identifier TEXT NOT NULL DEFAULT '',
  rights_basis TEXT NOT NULL DEFAULT 'owned' CHECK(rights_basis IN ('owned','licensed','public_domain')),
  territory_scope_json TEXT NOT NULL DEFAULT '{"mode":"worldwide","exclude":[]}',
  rights_start_at TEXT,
  rights_end_at TEXT,
  release_date TEXT,
  preorder_date TEXT,
  list_currency TEXT NOT NULL DEFAULT 'USD',
  list_price_minor INTEGER NOT NULL DEFAULT 0 CHECK(list_price_minor>=0),
  drm_requirement TEXT NOT NULL DEFAULT 'none',
  downloadable INTEGER NOT NULL DEFAULT 1 CHECK(downloadable IN (0,1)),
  subscription_permitted INTEGER NOT NULL DEFAULT 0 CHECK(subscription_permitted IN (0,1)),
  library_permitted INTEGER NOT NULL DEFAULT 0 CHECK(library_permitted IN (0,1)),
  sales_channels_json TEXT NOT NULL DEFAULT '["retail"]',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','validating','ready','submitted','changes_requested','approved','published','withdrawn')),
  revision INTEGER NOT NULL DEFAULT 1,
  catalog_edition_id TEXT REFERENCES editions(id) ON DELETE SET NULL,
  catalog_product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(title_id,format,edition_label)
);
CREATE INDEX idx_publishing_editions_title ON publishing_edition_drafts(title_id,status,updated_at DESC);

CREATE TABLE publishing_edition_contributors (
  edition_id TEXT NOT NULL REFERENCES publishing_edition_drafts(id) ON DELETE CASCADE,
  pen_name_id TEXT REFERENCES publishing_pen_names(id) ON DELETE SET NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('author','editor','translator','illustrator','narrator','other')),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(edition_id,display_name,role)
);

CREATE TABLE publishing_assets (
  id TEXT PRIMARY KEY NOT NULL,
  edition_id TEXT NOT NULL REFERENCES publishing_edition_drafts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('manuscript','cover','supplement','audio')),
  required INTEGER NOT NULL DEFAULT 0 CHECK(required IN (0,1)),
  current_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(edition_id,kind)
);

CREATE TABLE publishing_asset_versions (
  id TEXT PRIMARY KEY NOT NULL,
  asset_id TEXT NOT NULL REFERENCES publishing_assets(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  quarantine_status TEXT NOT NULL DEFAULT 'quarantined' CHECK(quarantine_status IN ('quarantined','scanning','clean','rejected','promoted')),
  extracted_metadata_json TEXT NOT NULL DEFAULT '{}',
  validation_summary TEXT NOT NULL DEFAULT 'pending' CHECK(validation_summary IN ('pending','running','passed','warning','blocked')),
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(asset_id,version_number)
);
CREATE INDEX idx_publishing_asset_hash ON publishing_asset_versions(sha256,mime_type);
CREATE INDEX idx_publishing_asset_queue ON publishing_asset_versions(quarantine_status,validation_summary,created_at);

CREATE TABLE publishing_validation_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  asset_version_id TEXT NOT NULL REFERENCES publishing_asset_versions(id) ON DELETE CASCADE,
  check_type TEXT NOT NULL CHECK(check_type IN ('malware','archive_safety','epubcheck','metadata','cover','images','navigation','links','fonts','fixed_layout','accessibility','render','device_compatibility','duplicate','audio_integrity')),
  required INTEGER NOT NULL DEFAULT 1 CHECK(required IN (0,1)),
  execution_class TEXT NOT NULL DEFAULT 'worker' CHECK(execution_class IN ('inline','worker','external')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','leased','passed','warning','failed','blocked','canceled')),
  priority INTEGER NOT NULL DEFAULT 100,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  idempotency_key TEXT NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(idempotency_key)
);
CREATE INDEX idx_publishing_validation_lease ON publishing_validation_jobs(status,available_at,priority,created_at);

CREATE TABLE publishing_validation_results (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES publishing_validation_jobs(id) ON DELETE CASCADE,
  asset_version_id TEXT NOT NULL REFERENCES publishing_asset_versions(id) ON DELETE CASCADE,
  check_type TEXT NOT NULL,
  validator_name TEXT NOT NULL,
  validator_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('passed','warning','failed','blocked')),
  issue_count INTEGER NOT NULL DEFAULT 0,
  issues_json TEXT NOT NULL DEFAULT '[]',
  report_object_key TEXT,
  report_sha256 TEXT,
  started_at TEXT,
  completed_at TEXT NOT NULL
);
CREATE INDEX idx_publishing_validation_asset ON publishing_validation_results(asset_version_id,check_type,completed_at DESC);

CREATE TABLE publishing_duplicate_matches (
  id TEXT PRIMARY KEY NOT NULL,
  asset_version_id TEXT NOT NULL REFERENCES publishing_asset_versions(id) ON DELETE CASCADE,
  matched_asset_version_id TEXT REFERENCES publishing_asset_versions(id) ON DELETE SET NULL,
  matched_catalog_edition_id TEXT REFERENCES editions(id) ON DELETE SET NULL,
  match_type TEXT NOT NULL CHECK(match_type IN ('exact_hash','metadata','isbn','fuzzy_content')),
  confidence REAL NOT NULL DEFAULT 1,
  disposition TEXT NOT NULL DEFAULT 'review' CHECK(disposition IN ('review','cleared','duplicate','fraud_hold')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_publishing_duplicates_asset ON publishing_duplicate_matches(asset_version_id,disposition);

CREATE TABLE publishing_submission_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  edition_id TEXT NOT NULL REFERENCES publishing_edition_drafts(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','in_review','changes_requested','approved','rejected','published','withdrawn')),
  submitted_by_user_id TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  decided_at TEXT,
  published_at TEXT,
  UNIQUE(edition_id,revision)
);
CREATE INDEX idx_publishing_submissions_review ON publishing_submission_snapshots(status,submitted_at);

CREATE TABLE publishing_submission_reviews (
  id TEXT PRIMARY KEY NOT NULL,
  submission_id TEXT NOT NULL REFERENCES publishing_submission_snapshots(id) ON DELETE CASCADE,
  reviewer_user_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approve','request_changes','reject','hold')),
  reason_code TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE publishing_publications (
  id TEXT PRIMARY KEY NOT NULL,
  submission_id TEXT NOT NULL UNIQUE REFERENCES publishing_submission_snapshots(id) ON DELETE RESTRICT,
  publishing_account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE RESTRICT,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  edition_id TEXT NOT NULL REFERENCES editions(id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  rights_contract_id TEXT REFERENCES rights_contracts(id) ON DELETE RESTRICT,
  royalty_contract_id TEXT REFERENCES finance_royalty_contracts(id) ON DELETE RESTRICT,
  offer_id TEXT REFERENCES offers(id) ON DELETE RESTRICT,
  manuscript_asset_version_id TEXT REFERENCES publishing_asset_versions(id) ON DELETE RESTRICT,
  cover_asset_version_id TEXT REFERENCES publishing_asset_versions(id) ON DELETE RESTRICT,
  materialization_key TEXT NOT NULL UNIQUE,
  published_at TEXT NOT NULL
);
CREATE INDEX idx_publishing_publications_account ON publishing_publications(publishing_account_id,published_at DESC);

CREATE TABLE publishing_audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT REFERENCES publishing_accounts(id) ON DELETE SET NULL,
  actor_user_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_publishing_audit_account ON publishing_audit_events(account_id,created_at DESC);
CREATE INDEX idx_publishing_audit_entity ON publishing_audit_events(entity_type,entity_id,created_at DESC);

-- Durable integration outbox: search, reporting, notifications and partner distribution consume this asynchronously.
CREATE TABLE publishing_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','delivered','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX idx_publishing_outbox_queue ON publishing_outbox(status,available_at,created_at);

-- Ensure an asset's current pointer always references one of its own versions.
CREATE TRIGGER trg_publishing_asset_current_version
BEFORE UPDATE OF current_version_id ON publishing_assets
WHEN NEW.current_version_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'publishing asset current version must belong to asset')
  WHERE NOT EXISTS(
    SELECT 1 FROM publishing_asset_versions v WHERE v.id=NEW.current_version_id AND v.asset_id=NEW.id
  );
END;

-- Submission snapshots are legal/audit evidence and may never be edited after submission except lifecycle timestamps/status.
CREATE TRIGGER trg_publishing_submission_snapshot_immutable
BEFORE UPDATE OF snapshot_json,snapshot_sha256,edition_id,account_id,revision,submitted_by_user_id,submitted_at ON publishing_submission_snapshots
BEGIN
  SELECT RAISE(ABORT,'publishing submission snapshot is immutable');
END;

CREATE TRIGGER trg_publishing_submission_no_delete
BEFORE DELETE ON publishing_submission_snapshots
BEGIN
  SELECT RAISE(ABORT,'publishing submission evidence cannot be deleted');
END;
