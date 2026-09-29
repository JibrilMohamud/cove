-- Commercial-grade publishing lifecycle, immutable publication versions, staff identity/RBAC,
-- moderation cases/appeals/sanctions, copyright and trust & safety workflows.

CREATE TABLE publishing_release_lifecycles (
  id TEXT PRIMARY KEY NOT NULL,
  publishing_edition_id TEXT NOT NULL UNIQUE REFERENCES publishing_edition_drafts(id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','validation','submitted','automated_review','human_review','approved','scheduled','preorder','live','updated','suppressed','takedown','retired')),
  current_publication_version_id TEXT,
  pending_publication_version_id TEXT,
  owner_update_policy TEXT NOT NULL DEFAULT 'auto_update' CHECK(owner_update_policy IN ('auto_update','manual_opt_in','preserve_purchased_version')),
  scheduled_at TEXT,
  preorder_at TEXT,
  live_at TEXT,
  suppressed_at TEXT,
  takedown_at TEXT,
  retired_at TEXT,
  state_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_publishing_release_state ON publishing_release_lifecycles(state,updated_at DESC);

CREATE TABLE publishing_publication_versions (
  id TEXT PRIMARY KEY NOT NULL,
  lifecycle_id TEXT NOT NULL REFERENCES publishing_release_lifecycles(id) ON DELETE RESTRICT,
  publication_id TEXT NOT NULL REFERENCES publishing_publications(id) ON DELETE RESTRICT,
  submission_id TEXT NOT NULL UNIQUE REFERENCES publishing_submission_snapshots(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL CHECK(version_number>0),
  previous_version_id TEXT REFERENCES publishing_publication_versions(id) ON DELETE RESTRICT,
  rollback_of_version_id TEXT REFERENCES publishing_publication_versions(id) ON DELETE RESTRICT,
  snapshot_sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  owner_delivery_policy TEXT NOT NULL DEFAULT 'auto_update' CHECK(owner_delivery_policy IN ('auto_update','manual_opt_in','preserve_purchased_version')),
  release_state TEXT NOT NULL CHECK(release_state IN ('scheduled','preorder','live','updated')),
  activated_at TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(lifecycle_id,version_number)
);
CREATE INDEX idx_publication_versions_lifecycle ON publishing_publication_versions(lifecycle_id,version_number DESC);

CREATE TABLE publishing_entitlement_version_pins (
  entitlement_id TEXT PRIMARY KEY NOT NULL REFERENCES entitlements(id) ON DELETE CASCADE,
  lifecycle_id TEXT NOT NULL REFERENCES publishing_release_lifecycles(id) ON DELETE RESTRICT,
  publication_version_id TEXT NOT NULL REFERENCES publishing_publication_versions(id) ON DELETE RESTRICT,
  policy_at_grant TEXT NOT NULL CHECK(policy_at_grant IN ('manual_opt_in','preserve_purchased_version')),
  pinned_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_publishing_entitlement_pins_version ON publishing_entitlement_version_pins(publication_version_id,entitlement_id);

CREATE TABLE publishing_owner_version_events (
  id TEXT PRIMARY KEY NOT NULL,
  entitlement_id TEXT NOT NULL REFERENCES entitlements(id) ON DELETE CASCADE,
  lifecycle_id TEXT NOT NULL REFERENCES publishing_release_lifecycles(id) ON DELETE RESTRICT,
  from_publication_version_id TEXT REFERENCES publishing_publication_versions(id) ON DELETE RESTRICT,
  to_publication_version_id TEXT NOT NULL REFERENCES publishing_publication_versions(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('grant_pin','policy_pin','owner_opt_in','staff_migration')),
  actor_user_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_publishing_owner_version_events ON publishing_owner_version_events(entitlement_id,created_at DESC);

CREATE TABLE publishing_lifecycle_events (
  id TEXT PRIMARY KEY NOT NULL,
  lifecycle_id TEXT NOT NULL REFERENCES publishing_release_lifecycles(id) ON DELETE RESTRICT,
  from_state TEXT,
  to_state TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK(trigger_type IN ('publisher','automation','staff','schedule','moderation','rollback','migration')),
  actor_user_id TEXT,
  reason_code TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_publishing_lifecycle_events ON publishing_lifecycle_events(lifecycle_id,created_at DESC);

CREATE TABLE publishing_automated_reviews (
  id TEXT PRIMARY KEY NOT NULL,
  submission_id TEXT NOT NULL REFERENCES publishing_submission_snapshots(id) ON DELETE RESTRICT,
  policy_version TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('pass','review','block')),
  risk_score INTEGER NOT NULL CHECK(risk_score BETWEEN 0 AND 100),
  signals_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE(submission_id,policy_version)
);
CREATE INDEX idx_publishing_automated_review_outcome ON publishing_automated_reviews(outcome,risk_score DESC,created_at DESC);

-- Staff identities are account identities, not shared operator bearer tokens. Roles are many-to-many,
-- permissions are explicit and every privileged API call additionally requires MFA assurance (aal2)
-- when the principal has mfa_required=1.
CREATE TABLE staff_principals (
  user_id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  sso_provider TEXT NOT NULL DEFAULT '',
  sso_subject TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','disabled')),
  mfa_required INTEGER NOT NULL DEFAULT 1 CHECK(mfa_required IN (0,1)),
  created_by_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_staff_sso_subject ON staff_principals(sso_provider,sso_subject) WHERE sso_provider<>'' AND sso_subject<>'';

CREATE TABLE staff_roles (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT ''
);
CREATE TABLE staff_role_permissions (
  role_id TEXT NOT NULL REFERENCES staff_roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY(role_id,permission)
);
CREATE TABLE staff_principal_roles (
  user_id TEXT NOT NULL REFERENCES staff_principals(user_id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES staff_roles(id) ON DELETE CASCADE,
  granted_by_user_id TEXT,
  granted_at TEXT NOT NULL,
  PRIMARY KEY(user_id,role_id)
);
CREATE INDEX idx_staff_principal_roles_role ON staff_principal_roles(role_id,user_id);

INSERT INTO staff_roles(id,name,description) VALUES
 ('role_publishing_reviewer','publishing_reviewer','Review publishing submissions and duplicate/content quality flags.'),
 ('role_trust_safety','trust_safety','Moderate reader/community and title/author abuse queues.'),
 ('role_copyright','copyright_agent','Handle copyright notices, counter-notices, and takedowns.'),
 ('role_fraud','fraud_analyst','Investigate scams, impersonation, duplicates, and repeat offenders.'),
 ('role_appeals','appeals_reviewer','Review moderation and publishing appeals.'),
 ('role_senior_moderator','senior_moderator','Escalations, sanctions, takedowns, and emergency suppression.'),
 ('role_moderation_admin','moderation_admin','Full moderation and publishing operations administration.');

INSERT INTO staff_role_permissions(role_id,permission) VALUES
 ('role_publishing_reviewer','publishing.review'),('role_publishing_reviewer','publishing.duplicate_review'),('role_publishing_reviewer','moderation.case.read'),('role_publishing_reviewer','moderation.note.write'),
 ('role_trust_safety','moderation.case.read'),('role_trust_safety','moderation.case.manage'),('role_trust_safety','moderation.note.write'),('role_trust_safety','moderation.review.manage'),('role_trust_safety','moderation.author.manage'),('role_trust_safety','moderation.title.manage'),
 ('role_copyright','moderation.case.read'),('role_copyright','moderation.case.manage'),('role_copyright','moderation.note.write'),('role_copyright','moderation.copyright.manage'),('role_copyright','moderation.takedown'),
 ('role_fraud','moderation.case.read'),('role_fraud','moderation.case.manage'),('role_fraud','moderation.note.write'),('role_fraud','moderation.fraud.manage'),('role_fraud','moderation.impersonation.manage'),('role_fraud','publishing.duplicate_review'),
 ('role_appeals','moderation.case.read'),('role_appeals','moderation.note.write'),('role_appeals','moderation.appeal.decide'),
 ('role_senior_moderator','moderation.case.read'),('role_senior_moderator','moderation.case.manage'),('role_senior_moderator','moderation.note.write'),('role_senior_moderator','moderation.sanction.manage'),('role_senior_moderator','moderation.takedown'),('role_senior_moderator','moderation.emergency_suppress'),('role_senior_moderator','publishing.rollback'),('role_senior_moderator','publishing.lifecycle.manage'),
 ('role_moderation_admin','publishing.review'),('role_moderation_admin','publishing.duplicate_review'),('role_moderation_admin','publishing.rollback'),('role_moderation_admin','publishing.lifecycle.manage'),('role_moderation_admin','moderation.case.read'),('role_moderation_admin','moderation.case.manage'),('role_moderation_admin','moderation.note.write'),('role_moderation_admin','moderation.review.manage'),('role_moderation_admin','moderation.author.manage'),('role_moderation_admin','moderation.title.manage'),('role_moderation_admin','moderation.copyright.manage'),('role_moderation_admin','moderation.fraud.manage'),('role_moderation_admin','moderation.impersonation.manage'),('role_moderation_admin','moderation.appeal.decide'),('role_moderation_admin','moderation.sanction.manage'),('role_moderation_admin','moderation.takedown'),('role_moderation_admin','moderation.emergency_suppress'),('role_moderation_admin','moderation.audit.read'),('role_moderation_admin','staff.manage');

CREATE TABLE moderation_cases (
  id TEXT PRIMARY KEY NOT NULL,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('review','title','edition','author','publisher','publishing_account','publication','user','copyright','impersonation','scam')),
  subject_id TEXT NOT NULL,
  publishing_account_id TEXT REFERENCES publishing_accounts(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  queue TEXT NOT NULL DEFAULT 'general' CHECK(queue IN ('reviews','titles','authors','publishers','copyright','fraud','impersonation','appeals','publishing','general')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','triage','in_review','waiting_external','actioned','appealed','resolved','closed')),
  source_type TEXT NOT NULL DEFAULT 'system' CHECK(source_type IN ('system','user_report','publisher','staff','copyright_notice','automated_review')),
  source_ref TEXT NOT NULL DEFAULT '',
  assigned_to_user_id TEXT REFERENCES staff_principals(user_id) ON DELETE SET NULL,
  risk_score INTEGER NOT NULL DEFAULT 0 CHECK(risk_score BETWEEN 0 AND 100),
  report_count INTEGER NOT NULL DEFAULT 1 CHECK(report_count>=0),
  summary TEXT NOT NULL DEFAULT '',
  sla_due_at TEXT,
  opened_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_moderation_queue ON moderation_cases(queue,status,priority,sla_due_at,opened_at);
CREATE INDEX idx_moderation_subject ON moderation_cases(subject_type,subject_id,opened_at DESC);
CREATE INDEX idx_moderation_account ON moderation_cases(publishing_account_id,status,opened_at DESC);
CREATE UNIQUE INDEX idx_moderation_source_ref ON moderation_cases(source_type,source_ref) WHERE source_ref<>'';

CREATE TABLE moderation_case_reports (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL REFERENCES moderation_cases(id) ON DELETE CASCADE,
  reporter_user_id TEXT,
  reason_code TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_moderation_reports_case ON moderation_case_reports(case_id,created_at DESC);

CREATE TABLE moderation_case_events (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL REFERENCES moderation_cases(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('staff','publisher','reporter','system')),
  actor_user_id TEXT,
  event_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_moderation_case_events_case ON moderation_case_events(case_id,created_at DESC);

CREATE TABLE moderation_notes (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL REFERENCES moderation_cases(id) ON DELETE RESTRICT,
  staff_user_id TEXT NOT NULL REFERENCES staff_principals(user_id) ON DELETE RESTRICT,
  visibility TEXT NOT NULL DEFAULT 'internal' CHECK(visibility IN ('internal','publisher_visible')),
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_moderation_notes_case ON moderation_notes(case_id,created_at DESC);

CREATE TABLE moderation_signals (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT REFERENCES moderation_cases(id) ON DELETE SET NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  detector TEXT NOT NULL,
  detector_version TEXT NOT NULL DEFAULT '',
  signal_type TEXT NOT NULL,
  score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_moderation_signals_subject ON moderation_signals(subject_type,subject_id,created_at DESC);

CREATE TABLE moderation_actions (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL REFERENCES moderation_cases(id) ON DELETE RESTRICT,
  staff_user_id TEXT NOT NULL REFERENCES staff_principals(user_id) ON DELETE RESTRICT,
  action_type TEXT NOT NULL CHECK(action_type IN ('no_action','hide_review','show_review','warn_publisher','restrict_publisher','suspend_publisher','suppress_title','restore_title','takedown_title','retire_title','reject_submission','approve_submission','escalate','copyright_takedown','copyright_restore','impersonation_remove')),
  reason_code TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',
  reversible INTEGER NOT NULL DEFAULT 1 CHECK(reversible IN (0,1)),
  reversed_by_action_id TEXT REFERENCES moderation_actions(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_moderation_actions_case ON moderation_actions(case_id,created_at DESC);

CREATE TABLE moderation_appeals (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL REFERENCES moderation_cases(id) ON DELETE RESTRICT,
  action_id TEXT REFERENCES moderation_actions(id) ON DELETE RESTRICT,
  appellant_user_id TEXT NOT NULL,
  publishing_account_id TEXT REFERENCES publishing_accounts(id) ON DELETE SET NULL,
  statement TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','in_review','granted','denied','withdrawn')),
  decided_by_user_id TEXT REFERENCES staff_principals(user_id) ON DELETE SET NULL,
  decision_notes TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX idx_moderation_appeals_queue ON moderation_appeals(status,submitted_at);
CREATE UNIQUE INDEX idx_moderation_appeals_one_open_per_case ON moderation_appeals(case_id) WHERE status IN ('submitted','in_review');

CREATE TABLE moderation_sanctions (
  id TEXT PRIMARY KEY NOT NULL,
  publishing_account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE RESTRICT,
  case_id TEXT NOT NULL REFERENCES moderation_cases(id) ON DELETE RESTRICT,
  action_id TEXT REFERENCES moderation_actions(id) ON DELETE SET NULL,
  sanction_type TEXT NOT NULL CHECK(sanction_type IN ('warning','publishing_restriction','temporary_suspension','permanent_suspension','payout_hold')),
  strike_points INTEGER NOT NULL DEFAULT 0 CHECK(strike_points>=0),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','lifted')),
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_moderation_sanctions_account ON moderation_sanctions(publishing_account_id,status,starts_at DESC);

CREATE TABLE copyright_complaints (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL UNIQUE REFERENCES moderation_cases(id) ON DELETE RESTRICT,
  complainant_user_id TEXT,
  claimant_name TEXT NOT NULL,
  claimant_email TEXT NOT NULL,
  represented_party TEXT NOT NULL DEFAULT '',
  work_description TEXT NOT NULL,
  allegedly_infringing_url TEXT NOT NULL DEFAULT '',
  good_faith_attestation INTEGER NOT NULL CHECK(good_faith_attestation IN (0,1)),
  accuracy_attestation INTEGER NOT NULL CHECK(accuracy_attestation IN (0,1)),
  signature_name TEXT NOT NULL,
  notice_status TEXT NOT NULL DEFAULT 'received' CHECK(notice_status IN ('received','needs_info','valid','invalid','actioned','counter_notice','restored','closed')),
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_copyright_status ON copyright_complaints(notice_status,received_at);

-- Migrate legacy reader-review reports into the unified, identity-bound moderation queue.
INSERT OR IGNORE INTO moderation_cases(id,subject_type,subject_id,category,queue,priority,status,source_type,source_ref,risk_score,report_count,summary,opened_at,updated_at)
SELECT 'modcase_review_'||replace(f.review_id,'-','')||'_'||replace(lower(f.reason),' ','_'),'review',f.review_id,f.reason,'reviews',
  CASE WHEN COUNT(*)>=15 THEN 'urgent' WHEN COUNT(*)>=5 THEN 'high' ELSE 'normal' END,'open','user_report','',MIN(100,20+(COUNT(*)*3)),COUNT(*),
  'Migrated reader-review reports: '||f.reason,MIN(f.created_at),MAX(f.created_at)
FROM review_reports f GROUP BY f.review_id,f.reason;

INSERT INTO moderation_case_reports(id,case_id,reporter_user_id,reason_code,details,evidence_json,created_at)
SELECT 'modreport_legacy_'||lower(hex(randomblob(16))),'modcase_review_'||replace(f.review_id,'-','')||'_'||replace(lower(f.reason),' ','_'),f.user_id,f.reason,'Migrated from the legacy reader-review report queue.','{}',f.created_at
FROM review_reports f;

INSERT INTO moderation_case_events(id,case_id,event_type,actor_type,actor_user_id,event_json,created_at)
SELECT 'modevt_legacy_'||lower(hex(randomblob(16))),c.id,'legacy_reports_migrated','system',NULL,json_object('reportCount',c.report_count),c.opened_at
FROM moderation_cases c WHERE c.source_type='user_report' AND c.subject_type='review' AND c.id LIKE 'modcase_review_%';

-- Immutable evidence. State changes are represented by new lifecycle events/actions/versions.
CREATE TRIGGER trg_publishing_publication_version_no_update BEFORE UPDATE ON publishing_publication_versions BEGIN
  SELECT RAISE(ABORT,'publication versions are immutable');
END;
CREATE TRIGGER trg_publishing_publication_version_no_delete BEFORE DELETE ON publishing_publication_versions BEGIN
  SELECT RAISE(ABORT,'publication versions cannot be deleted');
END;
CREATE TRIGGER trg_publishing_lifecycle_event_no_update BEFORE UPDATE ON publishing_lifecycle_events BEGIN
  SELECT RAISE(ABORT,'publishing lifecycle history is append-only');
END;
CREATE TRIGGER trg_publishing_lifecycle_event_no_delete BEFORE DELETE ON publishing_lifecycle_events BEGIN
  SELECT RAISE(ABORT,'publishing lifecycle history is append-only');
END;
CREATE TRIGGER trg_publishing_automated_review_no_update BEFORE UPDATE ON publishing_automated_reviews BEGIN
  SELECT RAISE(ABORT,'automated review evidence is immutable');
END;
CREATE TRIGGER trg_publishing_automated_review_no_delete BEFORE DELETE ON publishing_automated_reviews BEGIN
  SELECT RAISE(ABORT,'automated review evidence is immutable');
END;
CREATE TRIGGER trg_publishing_asset_version_core_immutable
BEFORE UPDATE OF asset_id,version_number,object_key,original_filename,mime_type,size_bytes,sha256,created_by_user_id,created_at ON publishing_asset_versions BEGIN
  SELECT RAISE(ABORT,'publishing asset version content identity is immutable');
END;
CREATE TRIGGER trg_publishing_asset_version_no_delete BEFORE DELETE ON publishing_asset_versions BEGIN
  SELECT RAISE(ABORT,'publishing asset version history cannot be deleted');
END;
CREATE TRIGGER trg_moderation_notes_no_update BEFORE UPDATE ON moderation_notes BEGIN SELECT RAISE(ABORT,'moderator notes are append-only'); END;
CREATE TRIGGER trg_moderation_notes_no_delete BEFORE DELETE ON moderation_notes BEGIN SELECT RAISE(ABORT,'moderator notes are append-only'); END;
CREATE TRIGGER trg_moderation_actions_no_update BEFORE UPDATE OF case_id,staff_user_id,action_type,reason_code,rationale,reversible,created_at ON moderation_actions BEGIN SELECT RAISE(ABORT,'moderation action evidence is immutable'); END;
CREATE TRIGGER trg_moderation_actions_no_delete BEFORE DELETE ON moderation_actions BEGIN SELECT RAISE(ABORT,'moderation action evidence cannot be deleted'); END;
CREATE TRIGGER trg_moderation_reports_no_update BEFORE UPDATE ON moderation_case_reports BEGIN SELECT RAISE(ABORT,'moderation reports are append-only'); END;
CREATE TRIGGER trg_moderation_reports_no_delete BEFORE DELETE ON moderation_case_reports BEGIN SELECT RAISE(ABORT,'moderation reports are append-only'); END;
CREATE TRIGGER trg_moderation_case_event_no_update BEFORE UPDATE ON moderation_case_events BEGIN SELECT RAISE(ABORT,'moderation case events are append-only'); END;
CREATE TRIGGER trg_moderation_case_event_no_delete BEFORE DELETE ON moderation_case_events BEGIN SELECT RAISE(ABORT,'moderation case events are append-only'); END;

CREATE TRIGGER trg_publishing_owner_version_event_no_update BEFORE UPDATE ON publishing_owner_version_events BEGIN SELECT RAISE(ABORT,'owner version history is append-only'); END;
CREATE TRIGGER trg_publishing_owner_version_event_no_delete BEFORE DELETE ON publishing_owner_version_events BEGIN SELECT RAISE(ABORT,'owner version history is append-only'); END;

-- Backfill a lifecycle for editions that existed before this migration.
INSERT INTO publishing_release_lifecycles(id,publishing_edition_id,state,owner_update_policy,live_at,created_at,updated_at)
SELECT 'lifecycle_'||lower(hex(randomblob(16))),e.id,
 CASE e.status WHEN 'published' THEN 'live' WHEN 'approved' THEN 'approved' WHEN 'submitted' THEN 'human_review' WHEN 'validating' THEN 'validation' ELSE 'draft' END,
 'auto_update',CASE WHEN e.status='published' THEN e.updated_at ELSE NULL END,e.created_at,e.updated_at
FROM publishing_edition_drafts e
WHERE NOT EXISTS(SELECT 1 FROM publishing_release_lifecycles l WHERE l.publishing_edition_id=e.id);
