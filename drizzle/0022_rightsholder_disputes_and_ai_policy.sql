-- Commercial rightsholder dispute operations, scoped royalty holds, fingerprint/risk graph,
-- and explicit AI/automated-content policy disclosures.

CREATE TABLE publishing_rights_declarations (
  id TEXT PRIMARY KEY NOT NULL,
  edition_id TEXT NOT NULL REFERENCES publishing_edition_drafts(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision>0),
  policy_version TEXT NOT NULL DEFAULT 'fore-rights-v1',
  rights_basis TEXT NOT NULL CHECK(rights_basis IN ('owned','licensed','public_domain')),
  authority_type TEXT NOT NULL CHECK(authority_type IN ('copyright_owner','exclusive_licensee','nonexclusive_licensee','authorized_agent','public_domain_republisher')),
  rights_owner_name TEXT NOT NULL,
  source_work_title TEXT NOT NULL DEFAULT '',
  source_work_author TEXT NOT NULL DEFAULT '',
  source_work_identifier TEXT NOT NULL DEFAULT '',
  territory_scope_json TEXT NOT NULL DEFAULT '{"mode":"worldwide","exclude":[]}',
  rights_start_at TEXT,
  rights_end_at TEXT,
  rights_summary TEXT NOT NULL DEFAULT '',
  authority_attestation INTEGER NOT NULL CHECK(authority_attestation IN (0,1)),
  no_infringement_attestation INTEGER NOT NULL CHECK(no_infringement_attestation IN (0,1)),
  evidence_complete_attestation INTEGER NOT NULL CHECK(evidence_complete_attestation IN (0,1)),
  signature_name TEXT NOT NULL,
  signed_by_user_id TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'signed' CHECK(status IN ('signed','challenged','verified','superseded')),
  created_at TEXT NOT NULL,
  UNIQUE(edition_id,revision)
);
CREATE INDEX idx_rights_declarations_account ON publishing_rights_declarations(account_id,status,signed_at DESC);

CREATE TABLE publishing_rights_evidence (
  id TEXT PRIMARY KEY NOT NULL,
  declaration_id TEXT NOT NULL REFERENCES publishing_rights_declarations(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE RESTRICT,
  evidence_type TEXT NOT NULL CHECK(evidence_type IN ('license','assignment','contract','registration','permission','public_domain_source','identity_authority','other')),
  description TEXT NOT NULL DEFAULT '',
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  scan_status TEXT NOT NULL DEFAULT 'queued' CHECK(scan_status IN ('queued','leased','clean','rejected','failed')),
  verification_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK(verification_status IN ('unreviewed','verified','insufficient','rejected')),
  issued_by TEXT NOT NULL DEFAULT '',
  issued_at TEXT,
  expires_at TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_rights_evidence_declaration ON publishing_rights_evidence(declaration_id,created_at DESC);
CREATE INDEX idx_rights_evidence_hash ON publishing_rights_evidence(sha256);

CREATE TABLE publishing_rights_evidence_scan_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  evidence_id TEXT NOT NULL UNIQUE REFERENCES publishing_rights_evidence(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','leased','passed','failed','blocked')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_rights_evidence_scan_queue ON publishing_rights_evidence_scan_jobs(status,available_at,created_at);

CREATE TABLE publishing_ai_disclosures (
  id TEXT PRIMARY KEY NOT NULL,
  edition_id TEXT NOT NULL REFERENCES publishing_edition_drafts(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision>0),
  policy_version TEXT NOT NULL DEFAULT 'fore-ai-content-v1',
  text_origin TEXT NOT NULL CHECK(text_origin IN ('human','ai_assisted','ai_generated','mixed')),
  cover_origin TEXT NOT NULL CHECK(cover_origin IN ('human','ai_assisted','ai_generated','mixed','not_applicable')),
  narration_origin TEXT NOT NULL CHECK(narration_origin IN ('human','ai_assisted','ai_generated','mixed','not_applicable')),
  translation_origin TEXT NOT NULL CHECK(translation_origin IN ('human','ai_assisted','ai_generated','mixed','not_applicable')),
  synthetic_voice_label TEXT NOT NULL DEFAULT '',
  model_names_json TEXT NOT NULL DEFAULT '[]',
  generation_notes TEXT NOT NULL DEFAULT '',
  human_editorial_review_attestation INTEGER NOT NULL CHECK(human_editorial_review_attestation IN (0,1)),
  rights_responsibility_attestation INTEGER NOT NULL CHECK(rights_responsibility_attestation IN (0,1)),
  non_spam_attestation INTEGER NOT NULL CHECK(non_spam_attestation IN (0,1)),
  signature_name TEXT NOT NULL,
  signed_by_user_id TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(edition_id,revision)
);
CREATE INDEX idx_ai_disclosures_account ON publishing_ai_disclosures(account_id,signed_at DESC);

CREATE TABLE publishing_content_policy_assessments (
  id TEXT PRIMARY KEY NOT NULL,
  submission_id TEXT NOT NULL REFERENCES publishing_submission_snapshots(id) ON DELETE RESTRICT,
  ai_disclosure_id TEXT NOT NULL REFERENCES publishing_ai_disclosures(id) ON DELETE RESTRICT,
  policy_version TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('pass','review','block')),
  risk_score INTEGER NOT NULL CHECK(risk_score BETWEEN 0 AND 100),
  signals_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE(submission_id,policy_version)
);

CREATE TABLE publishing_asset_fingerprints (
  id TEXT PRIMARY KEY NOT NULL,
  asset_version_id TEXT NOT NULL UNIQUE REFERENCES publishing_asset_versions(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE RESTRICT,
  edition_id TEXT NOT NULL REFERENCES publishing_edition_drafts(id) ON DELETE RESTRICT,
  asset_kind TEXT NOT NULL,
  exact_sha256 TEXT NOT NULL,
  normalized_text_sha256 TEXT NOT NULL DEFAULT '',
  simhash64 TEXT NOT NULL DEFAULT '',
  simhash_band0 TEXT NOT NULL DEFAULT '',
  simhash_band1 TEXT NOT NULL DEFAULT '',
  simhash_band2 TEXT NOT NULL DEFAULT '',
  simhash_band3 TEXT NOT NULL DEFAULT '',
  token_count INTEGER NOT NULL DEFAULT 0,
  metadata_fingerprint TEXT NOT NULL DEFAULT '',
  detector_version TEXT NOT NULL DEFAULT 'fore-fingerprint-v1',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_asset_fingerprint_exact ON publishing_asset_fingerprints(exact_sha256,account_id);
CREATE INDEX idx_asset_fingerprint_text ON publishing_asset_fingerprints(normalized_text_sha256,account_id);
CREATE INDEX idx_asset_fingerprint_simhash ON publishing_asset_fingerprints(simhash64);
CREATE INDEX idx_asset_fingerprint_band0 ON publishing_asset_fingerprints(asset_kind,simhash_band0);
CREATE INDEX idx_asset_fingerprint_band1 ON publishing_asset_fingerprints(asset_kind,simhash_band1);
CREATE INDEX idx_asset_fingerprint_band2 ON publishing_asset_fingerprints(asset_kind,simhash_band2);
CREATE INDEX idx_asset_fingerprint_band3 ON publishing_asset_fingerprints(asset_kind,simhash_band3);

CREATE TABLE publishing_similarity_matches (
  id TEXT PRIMARY KEY NOT NULL,
  asset_version_id TEXT NOT NULL REFERENCES publishing_asset_versions(id) ON DELETE RESTRICT,
  matched_asset_version_id TEXT NOT NULL REFERENCES publishing_asset_versions(id) ON DELETE RESTRICT,
  similarity_type TEXT NOT NULL CHECK(similarity_type IN ('exact','normalized_text','simhash','metadata')),
  score REAL NOT NULL CHECK(score>=0 AND score<=1),
  cross_account INTEGER NOT NULL DEFAULT 0 CHECK(cross_account IN (0,1)),
  disposition TEXT NOT NULL DEFAULT 'review' CHECK(disposition IN ('review','cleared','authorized_overlap','infringing','fraud_hold')),
  detector_version TEXT NOT NULL DEFAULT 'fore-fingerprint-v1',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(asset_version_id,matched_asset_version_id,similarity_type)
);
CREATE INDEX idx_similarity_review ON publishing_similarity_matches(disposition,cross_account,score DESC,created_at DESC);

CREATE TABLE publishing_account_risk_links (
  id TEXT PRIMARY KEY NOT NULL,
  account_a_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE RESTRICT,
  account_b_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE RESTRICT,
  link_type TEXT NOT NULL CHECK(link_type IN ('shared_exact_asset','high_content_similarity','shared_payout_reference','shared_identity_reference','shared_contact_domain','shared_account_controller','repeated_impersonation_target')),
  score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  CHECK(account_a_id < account_b_id),
  UNIQUE(account_a_id,account_b_id,link_type)
);
CREATE INDEX idx_account_risk_links_a ON publishing_account_risk_links(account_a_id,score DESC,last_seen_at DESC);
CREATE INDEX idx_account_risk_links_b ON publishing_account_risk_links(account_b_id,score DESC,last_seen_at DESC);

CREATE TABLE publishing_risk_clusters (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','cleared','confirmed_fraud','monitoring')),
  risk_score INTEGER NOT NULL CHECK(risk_score BETWEEN 0 AND 100),
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE publishing_risk_cluster_members (
  cluster_id TEXT NOT NULL REFERENCES publishing_risk_clusters(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE RESTRICT,
  member_score INTEGER NOT NULL CHECK(member_score BETWEEN 0 AND 100),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  added_at TEXT NOT NULL,
  PRIMARY KEY(cluster_id,account_id)
);
CREATE INDEX idx_risk_cluster_account ON publishing_risk_cluster_members(account_id,cluster_id);

CREATE TABLE publishing_identity_similarity_matches (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE RESTRICT,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('publisher_name','pen_name','contributor')),
  subject_id TEXT NOT NULL,
  submitted_name TEXT NOT NULL,
  matched_entity_type TEXT NOT NULL CHECK(matched_entity_type IN ('publisher','contributor','publishing_account','pen_name')),
  matched_entity_id TEXT NOT NULL,
  matched_name TEXT NOT NULL,
  similarity_score INTEGER NOT NULL CHECK(similarity_score BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'review' CHECK(status IN ('review','cleared','authorized','impersonation')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_identity_similarity_review ON publishing_identity_similarity_matches(status,similarity_score DESC,created_at DESC);

CREATE TABLE rights_disputes (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL UNIQUE REFERENCES moderation_cases(id) ON DELETE RESTRICT,
  publishing_account_id TEXT REFERENCES publishing_accounts(id) ON DELETE SET NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  lifecycle_id TEXT REFERENCES publishing_release_lifecycles(id) ON DELETE SET NULL,
  legal_regime TEXT NOT NULL DEFAULT 'us_dmca' CHECK(legal_regime IN ('us_dmca','contractual','other')),
  status TEXT NOT NULL DEFAULT 'notice_received' CHECK(status IN ('notice_received','needs_info','notice_validated','taken_down','counter_received','counter_forwarded','waiting_restore_window','litigation_hold','restoration_eligible','restored','resolved','closed')),
  takedown_at TEXT,
  restore_not_before_at TEXT,
  restore_deadline_at TEXT,
  litigation_hold INTEGER NOT NULL DEFAULT 0 CHECK(litigation_hold IN (0,1)),
  resolution_code TEXT NOT NULL DEFAULT '',
  resolution_notes TEXT NOT NULL DEFAULT '',
  resolved_by_user_id TEXT REFERENCES staff_principals(user_id) ON DELETE SET NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_rights_dispute_queue ON rights_disputes(status,restore_not_before_at,created_at);
CREATE INDEX idx_rights_dispute_account ON rights_disputes(publishing_account_id,status,created_at DESC);

CREATE TABLE copyright_notices (
  id TEXT PRIMARY KEY NOT NULL,
  dispute_id TEXT NOT NULL UNIQUE REFERENCES rights_disputes(id) ON DELETE RESTRICT,
  complainant_user_id TEXT,
  claimant_name TEXT NOT NULL,
  claimant_email TEXT NOT NULL,
  claimant_address_json TEXT NOT NULL,
  claimant_phone TEXT NOT NULL,
  represented_party TEXT NOT NULL DEFAULT '',
  copyrighted_works_json TEXT NOT NULL,
  infringing_material_json TEXT NOT NULL,
  rights_basis TEXT NOT NULL DEFAULT '',
  good_faith_attestation INTEGER NOT NULL CHECK(good_faith_attestation IN (0,1)),
  accuracy_perjury_attestation INTEGER NOT NULL CHECK(accuracy_perjury_attestation IN (0,1)),
  authority_attestation INTEGER NOT NULL CHECK(authority_attestation IN (0,1)),
  signature_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','needs_info','compliant','noncompliant','actioned','countered','litigation_hold','restored','closed')),
  staff_validation_notes TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL,
  validated_at TEXT,
  actioned_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_copyright_notices_status ON copyright_notices(status,received_at);

CREATE TABLE copyright_counter_notices (
  id TEXT PRIMARY KEY NOT NULL,
  dispute_id TEXT NOT NULL REFERENCES rights_disputes(id) ON DELETE RESTRICT,
  notice_id TEXT NOT NULL REFERENCES copyright_notices(id) ON DELETE RESTRICT,
  publishing_account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE RESTRICT,
  submitter_user_id TEXT NOT NULL,
  subscriber_name TEXT NOT NULL,
  subscriber_address_json TEXT NOT NULL,
  subscriber_phone TEXT NOT NULL,
  removed_material_json TEXT NOT NULL,
  mistake_perjury_attestation INTEGER NOT NULL CHECK(mistake_perjury_attestation IN (0,1)),
  jurisdiction_consent INTEGER NOT NULL CHECK(jurisdiction_consent IN (0,1)),
  service_consent INTEGER NOT NULL CHECK(service_consent IN (0,1)),
  signature_name TEXT NOT NULL,
  statement TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','needs_info','compliant','rejected','forwarded','waiting','court_action','restored','closed')),
  received_at TEXT NOT NULL,
  validated_at TEXT,
  forwarded_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_counter_notice_one_open ON copyright_counter_notices(dispute_id) WHERE status IN ('received','needs_info','compliant','forwarded','waiting');

CREATE TABLE rights_dispute_events (
  id TEXT PRIMARY KEY NOT NULL,
  dispute_id TEXT NOT NULL REFERENCES rights_disputes(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('claimant','publisher','staff','system','worker')),
  actor_user_id TEXT,
  event_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_rights_dispute_events ON rights_dispute_events(dispute_id,created_at DESC);

CREATE TABLE royalty_holds (
  id TEXT PRIMARY KEY NOT NULL,
  dispute_id TEXT NOT NULL REFERENCES rights_disputes(id) ON DELETE RESTRICT,
  publishing_account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE RESTRICT,
  finance_party_id TEXT REFERENCES finance_parties(id) ON DELETE SET NULL,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('account','product','edition','publication')),
  scope_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','released','forfeited')),
  reason_code TEXT NOT NULL,
  started_by_user_id TEXT,
  started_at TEXT NOT NULL,
  released_by_user_id TEXT,
  released_at TEXT,
  release_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_royalty_holds_active ON royalty_holds(status,finance_party_id,scope_type,scope_id,started_at DESC);
CREATE UNIQUE INDEX idx_royalty_hold_one_active_scope ON royalty_holds(dispute_id,scope_type,scope_id) WHERE status='active';

CREATE TABLE publisher_infringement_incidents (
  id TEXT PRIMARY KEY NOT NULL,
  publishing_account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE RESTRICT,
  dispute_id TEXT NOT NULL REFERENCES rights_disputes(id) ON DELETE RESTRICT,
  incident_type TEXT NOT NULL CHECK(incident_type IN ('confirmed_infringement','court_order','repeat_reupload','fraudulent_rights_declaration')),
  strike_points INTEGER NOT NULL CHECK(strike_points>0),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','overturned','expired')),
  decided_by_user_id TEXT NOT NULL REFERENCES staff_principals(user_id) ON DELETE RESTRICT,
  rationale TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL,
  expires_at TEXT,
  UNIQUE(dispute_id,incident_type)
);
CREATE INDEX idx_infringement_incidents_account ON publisher_infringement_incidents(publishing_account_id,status,decided_at DESC);

CREATE TABLE repeat_infringer_policy_state (
  publishing_account_id TEXT PRIMARY KEY NOT NULL REFERENCES publishing_accounts(id) ON DELETE RESTRICT,
  active_incidents INTEGER NOT NULL DEFAULT 0,
  active_strike_points INTEGER NOT NULL DEFAULT 0,
  policy_state TEXT NOT NULL DEFAULT 'normal' CHECK(policy_state IN ('normal','warning','restricted','termination_review','terminated')),
  last_incident_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE rights_notification_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  dispute_id TEXT NOT NULL REFERENCES rights_disputes(id) ON DELETE RESTRICT,
  notification_type TEXT NOT NULL CHECK(notification_type IN ('notice_received','needs_info','notice_noncompliant','notice_actioned','takedown_to_publisher','counter_received','counter_needs_info','counter_rejected','counter_forwarded_to_claimant','court_action_recorded','restoration_scheduled','restored','dispute_resolved')),
  recipient_type TEXT NOT NULL CHECK(recipient_type IN ('claimant','publisher','staff')),
  recipient TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','leased','sent','failed','canceled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  provider_message_id TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_rights_notification_queue ON rights_notification_jobs(status,available_at,created_at);

-- New granular permissions; existing roles receive only what they need.
INSERT OR IGNORE INTO staff_role_permissions(role_id,permission) VALUES
 ('role_copyright','rights.notice.validate'),('role_copyright','rights.counter_notice.validate'),('role_copyright','rights.dispute.resolve'),('role_copyright','rights.royalty_hold.manage'),('role_copyright','rights.evidence.review'),
 ('role_fraud','rights.cluster.review'),('role_fraud','rights.identity_similarity.review'),('role_fraud','content.ai.review'),
 ('role_publishing_reviewer','rights.evidence.review'),('role_publishing_reviewer','content.ai.review'),
 ('role_senior_moderator','rights.dispute.resolve'),('role_senior_moderator','rights.royalty_hold.manage'),('role_senior_moderator','rights.repeat_infringer.manage'),
 ('role_moderation_admin','rights.notice.validate'),('role_moderation_admin','rights.counter_notice.validate'),('role_moderation_admin','rights.dispute.resolve'),('role_moderation_admin','rights.royalty_hold.manage'),('role_moderation_admin','rights.evidence.review'),('role_moderation_admin','rights.repeat_infringer.manage'),('role_moderation_admin','rights.cluster.review'),('role_moderation_admin','rights.identity_similarity.review'),('role_moderation_admin','content.ai.review');

-- Evidence and signed declarations are legal/audit records.
CREATE TRIGGER trg_rights_declaration_no_update BEFORE UPDATE ON publishing_rights_declarations BEGIN SELECT RAISE(ABORT,'signed rights declarations are immutable'); END;
CREATE TRIGGER trg_rights_declaration_no_delete BEFORE DELETE ON publishing_rights_declarations BEGIN SELECT RAISE(ABORT,'signed rights declarations cannot be deleted'); END;
CREATE TRIGGER trg_rights_evidence_core_immutable BEFORE UPDATE OF declaration_id,account_id,evidence_type,description,original_filename,mime_type,size_bytes,object_key,sha256,issued_by,issued_at,expires_at,created_by_user_id,created_at ON publishing_rights_evidence BEGIN SELECT RAISE(ABORT,'rights evidence content identity is immutable'); END;
CREATE TRIGGER trg_rights_evidence_no_delete BEFORE DELETE ON publishing_rights_evidence BEGIN SELECT RAISE(ABORT,'rights evidence cannot be deleted'); END;
CREATE TRIGGER trg_ai_disclosure_no_update BEFORE UPDATE ON publishing_ai_disclosures BEGIN SELECT RAISE(ABORT,'signed AI disclosure is immutable'); END;
CREATE TRIGGER trg_ai_disclosure_no_delete BEFORE DELETE ON publishing_ai_disclosures BEGIN SELECT RAISE(ABORT,'signed AI disclosure cannot be deleted'); END;
CREATE TRIGGER trg_content_policy_assessment_no_update BEFORE UPDATE ON publishing_content_policy_assessments BEGIN SELECT RAISE(ABORT,'content policy assessment evidence is immutable'); END;
CREATE TRIGGER trg_content_policy_assessment_no_delete BEFORE DELETE ON publishing_content_policy_assessments BEGIN SELECT RAISE(ABORT,'content policy assessment evidence cannot be deleted'); END;
CREATE TRIGGER trg_asset_fingerprint_no_update BEFORE UPDATE ON publishing_asset_fingerprints BEGIN SELECT RAISE(ABORT,'asset fingerprints are immutable'); END;
CREATE TRIGGER trg_asset_fingerprint_no_delete BEFORE DELETE ON publishing_asset_fingerprints BEGIN SELECT RAISE(ABORT,'asset fingerprints cannot be deleted'); END;
CREATE TRIGGER trg_rights_dispute_event_no_update BEFORE UPDATE ON rights_dispute_events BEGIN SELECT RAISE(ABORT,'rights dispute events are append-only'); END;
CREATE TRIGGER trg_rights_dispute_event_no_delete BEFORE DELETE ON rights_dispute_events BEGIN SELECT RAISE(ABORT,'rights dispute events are append-only'); END;
CREATE TRIGGER trg_infringement_incident_no_update BEFORE UPDATE OF publishing_account_id,dispute_id,incident_type,strike_points,decided_by_user_id,rationale,decided_at ON publisher_infringement_incidents BEGIN SELECT RAISE(ABORT,'infringement incident evidence is immutable'); END;
CREATE TRIGGER trg_infringement_incident_no_delete BEFORE DELETE ON publisher_infringement_incidents BEGIN SELECT RAISE(ABORT,'infringement incident evidence cannot be deleted'); END;
