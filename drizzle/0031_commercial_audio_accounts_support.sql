-- Commercial audiobook operations, customer account controls, and audited customer support.

CREATE TABLE IF NOT EXISTS commercial_audio_policy_versions (
  id TEXT PRIMARY KEY NOT NULL,
  policy_version TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('draft','active','retired')),
  policy_json TEXT NOT NULL,
  policy_sha256 TEXT NOT NULL,
  created_by_user_id TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_audio_policy_active ON commercial_audio_policy_versions(status) WHERE status='active';
CREATE TRIGGER IF NOT EXISTS trg_audio_policy_version_content_immutable BEFORE UPDATE ON commercial_audio_policy_versions WHEN NEW.id<>OLD.id OR NEW.policy_version<>OLD.policy_version OR NEW.policy_json<>OLD.policy_json OR NEW.policy_sha256<>OLD.policy_sha256 OR COALESCE(NEW.created_by_user_id,'')<>COALESCE(OLD.created_by_user_id,'') OR NEW.created_at<>OLD.created_at BEGIN SELECT RAISE(ABORT,'commercial audio policy version content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_audio_policy_version_no_delete BEFORE DELETE ON commercial_audio_policy_versions BEGIN SELECT RAISE(ABORT,'commercial audio policy versions are immutable'); END;

INSERT OR IGNORE INTO commercial_audio_policy_versions(id,policy_version,status,policy_json,policy_sha256,created_by_user_id,created_at) VALUES(
  'audiopol_fore_commercial_audio_v1','fore-commercial-audio-v1','active',
  '{"chapterFilesRequired":true,"sampleRateHz":44100,"allowedMimeTypes":["audio/mpeg","audio/mp4"],"mp3MinBitrateKbps":192,"mp3BitrateMode":"CBR","rmsDbMin":-23,"rmsDbMax":-18,"peakDbMax":-3,"noiseFloorDbMax":-60,"consistentChannelsRequired":true,"previewMinSeconds":30,"previewMaxSeconds":300,"narrationAgreementRequired":true,"rightsEvidenceRequired":true,"offlineLicenseRequired":true,"biosyncTimingMustBeVerified":true}',
  '8ee957b0b3d1d7cf10a99344f6b49c2ef96440ac4b2a96053eda925aab1e043b',
  'system','2026-09-25T00:00:00.000Z'
);

CREATE TABLE IF NOT EXISTS commercial_audio_profiles (
  edition_id TEXT PRIMARY KEY NOT NULL REFERENCES publishing_edition_drafts(id) ON DELETE CASCADE,
  publishing_account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE RESTRICT,
  audio_publisher TEXT NOT NULL DEFAULT '',
  copyright_notice TEXT NOT NULL DEFAULT '',
  performance_rights_basis TEXT NOT NULL DEFAULT '',
  performance_rights_evidence_id TEXT REFERENCES publishing_rights_evidence(id) ON DELETE SET NULL,
  identifier_type TEXT NOT NULL DEFAULT 'isbn13' CHECK(identifier_type IN ('isbn13','asin','ean','upc','publisher','other')),
  identifier_value TEXT NOT NULL DEFAULT '',
  credits_json TEXT NOT NULL DEFAULT '[]',
  territory_scope_json TEXT NOT NULL DEFAULT '{"mode":"worldwide","include":[],"exclude":[]}',
  subscription_eligible INTEGER NOT NULL DEFAULT 0 CHECK(subscription_eligible IN (0,1)),
  offline_eligible INTEGER NOT NULL DEFAULT 1 CHECK(offline_eligible IN (0,1)),
  preview_file_id TEXT,
  cover_asset_version_id TEXT REFERENCES publishing_asset_versions(id) ON DELETE SET NULL,
  active_policy_id TEXT NOT NULL REFERENCES commercial_audio_policy_versions(id) ON DELETE RESTRICT,
  qc_status TEXT NOT NULL DEFAULT 'pending' CHECK(qc_status IN ('pending','running','passed','warning','blocked')),
  rights_status TEXT NOT NULL DEFAULT 'pending' CHECK(rights_status IN ('pending','verified','blocked')),
  agreements_status TEXT NOT NULL DEFAULT 'pending' CHECK(agreements_status IN ('pending','verified','blocked')),
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audio_profiles_account ON commercial_audio_profiles(publishing_account_id,updated_at DESC);

CREATE TABLE IF NOT EXISTS commercial_audio_narrators (
  id TEXT PRIMARY KEY NOT NULL,
  edition_id TEXT NOT NULL REFERENCES publishing_edition_drafts(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  contributor_id TEXT REFERENCES contributors(id) ON DELETE SET NULL,
  narration_type TEXT NOT NULL DEFAULT 'human' CHECK(narration_type IN ('human','synthetic','mixed')),
  synthetic_voice_label TEXT NOT NULL DEFAULT '',
  billing_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audio_narrators_edition ON commercial_audio_narrators(edition_id,billing_order,id);

CREATE TABLE IF NOT EXISTS narration_agreements (
  id TEXT PRIMARY KEY NOT NULL,
  edition_id TEXT NOT NULL REFERENCES publishing_edition_drafts(id) ON DELETE CASCADE,
  narrator_id TEXT NOT NULL REFERENCES commercial_audio_narrators(id) ON DELETE RESTRICT,
  agreement_type TEXT NOT NULL CHECK(agreement_type IN ('employment','work_for_hire','license','union','synthetic_voice_license','other')),
  evidence_id TEXT NOT NULL REFERENCES publishing_rights_evidence(id) ON DELETE RESTRICT,
  territories_json TEXT NOT NULL DEFAULT '["WORLD"]',
  permitted_uses_json TEXT NOT NULL DEFAULT '["retail","subscription","library","preview","offline"]',
  signed_at TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','terminated','superseded')),
  attested_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_narration_agreements_edition ON narration_agreements(edition_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS narration_agreement_terminations (
  id TEXT PRIMARY KEY NOT NULL,
  agreement_id TEXT NOT NULL UNIQUE REFERENCES narration_agreements(id) ON DELETE RESTRICT,
  disposition TEXT NOT NULL CHECK(disposition IN ('terminated','superseded')),
  effective_at TEXT NOT NULL,
  replacement_agreement_id TEXT REFERENCES narration_agreements(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_narration_agreement_terminations_effective ON narration_agreement_terminations(effective_at,agreement_id);
CREATE TRIGGER IF NOT EXISTS trg_narration_agreement_termination_immutable_update BEFORE UPDATE ON narration_agreement_terminations BEGIN SELECT RAISE(ABORT,'narration agreement termination evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_narration_agreement_termination_immutable_delete BEFORE DELETE ON narration_agreement_terminations BEGIN SELECT RAISE(ABORT,'narration agreement termination evidence is immutable'); END;

CREATE TABLE IF NOT EXISTS commercial_audio_files (
  id TEXT PRIMARY KEY NOT NULL,
  edition_id TEXT NOT NULL REFERENCES publishing_edition_drafts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('chapter','preview')),
  object_key TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes>0),
  sha256 TEXT NOT NULL,
  duration_ms INTEGER,
  sample_rate_hz INTEGER,
  bitrate_kbps INTEGER,
  bitrate_mode TEXT NOT NULL DEFAULT '',
  channels INTEGER,
  loudness_rms_db REAL,
  true_peak_db REAL,
  noise_floor_db REAL,
  qc_status TEXT NOT NULL DEFAULT 'pending' CHECK(qc_status IN ('pending','passed','warning','failed')),
  quarantine_status TEXT NOT NULL DEFAULT 'clean' CHECK(quarantine_status IN ('quarantined','scanning','clean','rejected','promoted')),
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commercial_audio_files_edition ON commercial_audio_files(edition_id,kind,created_at);

CREATE TABLE IF NOT EXISTS commercial_audio_chapters (
  id TEXT PRIMARY KEY NOT NULL,
  edition_id TEXT NOT NULL REFERENCES publishing_edition_drafts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  file_id TEXT NOT NULL REFERENCES commercial_audio_files(id) ON DELETE RESTRICT,
  duration_ms INTEGER NOT NULL CHECK(duration_ms>0),
  mime_type TEXT NOT NULL,
  sample_rate_hz INTEGER NOT NULL,
  bitrate_kbps INTEGER,
  bitrate_mode TEXT NOT NULL DEFAULT '',
  channels INTEGER NOT NULL CHECK(channels BETWEEN 1 AND 8),
  loudness_rms_db REAL,
  true_peak_db REAL,
  noise_floor_db REAL,
  sha256 TEXT NOT NULL,
  qc_status TEXT NOT NULL DEFAULT 'pending' CHECK(qc_status IN ('pending','passed','warning','failed')),
  created_at TEXT NOT NULL,
  UNIQUE(edition_id,position),
  UNIQUE(edition_id,file_id)
);
CREATE INDEX IF NOT EXISTS idx_audio_chapters_edition ON commercial_audio_chapters(edition_id,position);

CREATE TABLE IF NOT EXISTS commercial_audio_qc_runs (
  id TEXT PRIMARY KEY NOT NULL,
  edition_id TEXT NOT NULL REFERENCES publishing_edition_drafts(id) ON DELETE RESTRICT,
  policy_id TEXT NOT NULL REFERENCES commercial_audio_policy_versions(id) ON DELETE RESTRICT,
  source_manifest_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('passed','warning','failed')),
  findings_json TEXT NOT NULL,
  measured_json TEXT NOT NULL,
  executed_by TEXT NOT NULL DEFAULT 'fore-audio-qc-worker',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audio_qc_edition ON commercial_audio_qc_runs(edition_id,created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_audio_qc_immutable_update BEFORE UPDATE ON commercial_audio_qc_runs BEGIN SELECT RAISE(ABORT,'audio QC evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_audio_qc_immutable_delete BEFORE DELETE ON commercial_audio_qc_runs BEGIN SELECT RAISE(ABORT,'audio QC evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_narration_agreement_immutable_update BEFORE UPDATE ON narration_agreements BEGIN SELECT RAISE(ABORT,'narration agreements are immutable; supersede with a new agreement'); END;
CREATE TRIGGER IF NOT EXISTS trg_narration_agreement_immutable_delete BEFORE DELETE ON narration_agreements BEGIN SELECT RAISE(ABORT,'narration agreements are immutable'); END;

CREATE TABLE IF NOT EXISTS commercial_biosync_links (
  id TEXT PRIMARY KEY NOT NULL,
  ebook_product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  audiobook_product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  ebook_asset_version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE RESTRICT,
  audio_manifest_hash TEXT NOT NULL,
  timing_manifest_object_key TEXT NOT NULL,
  timing_manifest_sha256 TEXT NOT NULL,
  precision TEXT NOT NULL CHECK(precision IN ('sentence','word')),
  coverage_bps INTEGER NOT NULL CHECK(coverage_bps BETWEEN 0 AND 10000),
  verification_status TEXT NOT NULL CHECK(verification_status IN ('verified','failed','superseded')),
  verified_by TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(ebook_product_id,audiobook_product_id,timing_manifest_sha256)
);
CREATE INDEX IF NOT EXISTS idx_biosync_pair ON commercial_biosync_links(ebook_product_id,audiobook_product_id,verification_status,verified_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_biosync_link_immutable_update BEFORE UPDATE ON commercial_biosync_links BEGIN SELECT RAISE(ABORT,'Biosync verification manifests are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_biosync_link_immutable_delete BEFORE DELETE ON commercial_biosync_links BEGIN SELECT RAISE(ABORT,'Biosync verification manifests are immutable'); END;

CREATE TABLE IF NOT EXISTS commercial_biosync_positions (
  user_id TEXT NOT NULL,
  biosync_link_id TEXT NOT NULL REFERENCES commercial_biosync_links(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('text','audio')),
  cfi TEXT NOT NULL,
  chapter_id TEXT,
  audio_ms INTEGER NOT NULL CHECK(audio_ms>=0),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id,biosync_link_id)
);

CREATE TABLE IF NOT EXISTS audio_offline_licenses (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  entitlement_id TEXT NOT NULL REFERENCES entitlements(id) ON DELETE CASCADE,
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  license_version INTEGER NOT NULL DEFAULT 1,
  token_hash TEXT NOT NULL UNIQUE,
  manifest_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','revoked')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT NOT NULL DEFAULT '',
  last_refreshed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audio_offline_user ON audio_offline_licenses(user_id,product_id,status,expires_at);

-- Customer account management: secrets/payment instruments remain with identity/payment providers.
CREATE TABLE IF NOT EXISTS account_preferences (
  user_id TEXT PRIMARY KEY NOT NULL,
  storefront_country TEXT NOT NULL DEFAULT 'US',
  privacy_json TEXT NOT NULL DEFAULT '{"analytics":true,"personalization":true}',
  marketing_json TEXT NOT NULL DEFAULT '{"email":false,"product":false,"authorReleases":true,"deals":false}',
  notifications_json TEXT NOT NULL DEFAULT '{"orders":true,"security":true,"preorders":true,"authorReleases":true,"priceDrops":true}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_addresses (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  address_type TEXT NOT NULL CHECK(address_type IN ('billing','shipping','tax')),
  recipient_name TEXT NOT NULL DEFAULT '',
  line1 TEXT NOT NULL,
  line2 TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL,
  country_code TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_addresses_user ON account_addresses(user_id,address_type,is_default DESC,updated_at DESC);

CREATE TABLE IF NOT EXISTS account_billing_methods (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'stripe',
  provider_customer_id TEXT NOT NULL,
  provider_payment_method_id TEXT NOT NULL,
  brand TEXT NOT NULL DEFAULT '',
  last4 TEXT NOT NULL DEFAULT '',
  exp_month INTEGER,
  exp_year INTEGER,
  billing_name TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','detached','expired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider,provider_payment_method_id)
);
CREATE INDEX IF NOT EXISTS idx_billing_methods_user ON account_billing_methods(user_id,status,is_default DESC);

CREATE TABLE IF NOT EXISTS account_security_events (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user','staff','system','provider')),
  actor_user_id TEXT,
  session_fingerprint TEXT NOT NULL DEFAULT '',
  ip_country TEXT NOT NULL DEFAULT '',
  user_agent_summary TEXT NOT NULL DEFAULT '',
  event_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_security_user ON account_security_events(user_id,created_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_account_security_immutable_update BEFORE UPDATE ON account_security_events BEGIN SELECT RAISE(ABORT,'security events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_account_security_immutable_delete BEFORE DELETE ON account_security_events BEGIN SELECT RAISE(ABORT,'security events are immutable'); END;

CREATE TABLE IF NOT EXISTS account_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  provider_session_id_hash TEXT NOT NULL,
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  user_agent_summary TEXT NOT NULL DEFAULT '',
  ip_country TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT NOT NULL DEFAULT '',
  UNIQUE(user_id,provider_session_id_hash)
);
CREATE INDEX IF NOT EXISTS idx_account_sessions_user ON account_sessions(user_id,revoked_at,last_seen_at DESC);

CREATE TABLE IF NOT EXISTS account_deletion_requests (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('requested','cooling_off','queued','executing','completed','canceled','blocked_legal_hold')),
  requested_at TEXT NOT NULL,
  execute_after TEXT NOT NULL,
  canceled_at TEXT,
  completed_at TEXT,
  legal_hold_reason TEXT NOT NULL DEFAULT '',
  confirmation_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_deletion_user ON account_deletion_requests(user_id,status,requested_at DESC);

CREATE TABLE IF NOT EXISTS account_recovery_events (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT,
  email_hash TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('requested','provider_sent','verified','completed','failed','staff_escalated')),
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user','staff','system','provider')),
  actor_user_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_recovery_user ON account_recovery_events(user_id,created_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_account_recovery_immutable_update BEFORE UPDATE ON account_recovery_events BEGIN SELECT RAISE(ABORT,'recovery events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_account_recovery_immutable_delete BEFORE DELETE ON account_recovery_events BEGIN SELECT RAISE(ABORT,'recovery events are immutable'); END;

-- Audited support operations. Searches and actions require staff identity + permission + MFA.
CREATE TABLE IF NOT EXISTS support_cases (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT,
  order_id TEXT REFERENCES commerce_orders(id) ON DELETE SET NULL,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  publisher_account_id TEXT REFERENCES publishing_accounts(id) ON DELETE SET NULL,
  category TEXT NOT NULL CHECK(category IN ('billing','refund','entitlement','download','account','publication','subscription','device','other')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','pending_customer','pending_internal','resolved','closed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  subject TEXT NOT NULL,
  created_by_staff_user_id TEXT NOT NULL REFERENCES staff_principals(user_id) ON DELETE RESTRICT,
  assigned_to_staff_user_id TEXT REFERENCES staff_principals(user_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_support_cases_queue ON support_cases(status,priority,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_cases_user ON support_cases(user_id,updated_at DESC);

CREATE TABLE IF NOT EXISTS support_case_events (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  staff_user_id TEXT REFERENCES staff_principals(user_id) ON DELETE SET NULL,
  note TEXT NOT NULL DEFAULT '',
  event_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_case_events ON support_case_events(case_id,created_at);
CREATE TRIGGER IF NOT EXISTS trg_support_case_events_immutable_update BEFORE UPDATE ON support_case_events BEGIN SELECT RAISE(ABORT,'support timeline is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_support_case_events_immutable_delete BEFORE DELETE ON support_case_events BEGIN SELECT RAISE(ABORT,'support timeline is immutable'); END;

CREATE TABLE IF NOT EXISTS support_actions (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL REFERENCES support_cases(id) ON DELETE RESTRICT,
  staff_user_id TEXT NOT NULL REFERENCES staff_principals(user_id) ON DELETE RESTRICT,
  action_type TEXT NOT NULL CHECK(action_type IN ('resend_receipt','refund','restore_entitlement','revoke_entitlement','reset_publication','requeue_download','revoke_device','security_recovery','note_only')),
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  rationale TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  provider_reference TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_actions_case ON support_actions(case_id,created_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_support_actions_immutable_update BEFORE UPDATE ON support_actions BEGIN SELECT RAISE(ABORT,'support actions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_support_actions_immutable_delete BEFORE DELETE ON support_actions BEGIN SELECT RAISE(ABORT,'support actions are immutable'); END;

INSERT OR IGNORE INTO staff_roles(id,name,description) VALUES
 ('role_customer_support','customer_support','Customer support search, receipts, entitlements, devices, and case timelines.'),
 ('role_support_admin','support_admin','Senior customer support with refund and publication recovery authority.');

INSERT OR IGNORE INTO staff_role_permissions(role_id,permission) VALUES
 ('role_customer_support','support.read'),('role_customer_support','support.case.manage'),('role_customer_support','support.receipt.resend'),('role_customer_support','support.entitlement.manage'),('role_customer_support','support.device.manage'),('role_customer_support','support.payment.read'),
 ('role_support_admin','support.read'),('role_support_admin','support.case.manage'),('role_support_admin','support.receipt.resend'),('role_support_admin','support.entitlement.manage'),('role_support_admin','support.device.manage'),('role_support_admin','support.payment.read'),('role_support_admin','support.refund'),('role_support_admin','support.publication.manage'),('role_support_admin','account.recovery.manage'),
 ('role_moderation_admin','support.read'),('role_moderation_admin','support.case.manage'),('role_moderation_admin','support.receipt.resend'),('role_moderation_admin','support.entitlement.manage'),('role_moderation_admin','support.device.manage'),('role_moderation_admin','support.payment.read'),('role_moderation_admin','support.refund'),('role_moderation_admin','support.publication.manage'),('role_moderation_admin','account.recovery.manage'),
 ('role_publishing_reviewer','audio.qc.review'),('role_publishing_reviewer','audio.rights.review'),('role_moderation_admin','audio.qc.review'),('role_moderation_admin','audio.rights.review');

CREATE TABLE IF NOT EXISTS account_gift_card_wallet (
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL REFERENCES commerce_gift_cards(code_hash) ON DELETE RESTRICT,
  nickname TEXT NOT NULL DEFAULT '',
  added_at TEXT NOT NULL,
  PRIMARY KEY(user_id,code_hash)
);
CREATE INDEX IF NOT EXISTS idx_gift_wallet_user ON account_gift_card_wallet(user_id,added_at DESC);


-- Commercial playback state is separate from Gutenberg audio_editions so FKs stay truthful.
CREATE TABLE IF NOT EXISTS commercial_audio_playback (
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL,
  seconds REAL NOT NULL DEFAULT 0 CHECK(seconds>=0),
  speed REAL NOT NULL DEFAULT 1 CHECK(speed>=0.5 AND speed<=3),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id,product_id)
);
CREATE INDEX IF NOT EXISTS idx_commercial_audio_playback_product ON commercial_audio_playback(product_id,updated_at DESC);

-- Durable audio QC work queue. Draft audio may change; immutable QC runs remain evidence.
CREATE TABLE IF NOT EXISTS commercial_audio_qc_jobs (
  edition_id TEXT PRIMARY KEY NOT NULL REFERENCES publishing_edition_drafts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','leased','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  lease_owner TEXT,
  lease_expires_at TEXT,
  available_at TEXT NOT NULL,
  last_run_id TEXT REFERENCES commercial_audio_qc_runs(id) ON DELETE SET NULL,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audio_qc_jobs_queue ON commercial_audio_qc_jobs(status,available_at,updated_at);

-- Freeze the exact commercial-audio manifest reviewed with each publishing submission.
CREATE TABLE IF NOT EXISTS commercial_audio_submission_snapshots (
  submission_id TEXT PRIMARY KEY NOT NULL REFERENCES publishing_submission_snapshots(id) ON DELETE RESTRICT,
  edition_id TEXT NOT NULL REFERENCES publishing_edition_drafts(id) ON DELETE RESTRICT,
  policy_id TEXT NOT NULL REFERENCES commercial_audio_policy_versions(id) ON DELETE RESTRICT,
  manifest_json TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audio_submission_snapshots_edition ON commercial_audio_submission_snapshots(edition_id,created_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_audio_submission_snapshot_no_update BEFORE UPDATE ON commercial_audio_submission_snapshots BEGIN SELECT RAISE(ABORT,'commercial audio submission snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_audio_submission_snapshot_no_delete BEFORE DELETE ON commercial_audio_submission_snapshots BEGIN SELECT RAISE(ABORT,'commercial audio submission snapshots are immutable'); END;
