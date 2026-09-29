-- Append-only activation history and staff access-management audit.
-- Publication-version rows remain immutable; each time a version becomes the serving version,
-- including a scheduled launch or rollback, record a separate activation event.

CREATE TABLE publishing_publication_activations (
  id TEXT PRIMARY KEY NOT NULL,
  lifecycle_id TEXT NOT NULL REFERENCES publishing_release_lifecycles(id) ON DELETE RESTRICT,
  publication_version_id TEXT NOT NULL REFERENCES publishing_publication_versions(id) ON DELETE RESTRICT,
  from_publication_version_id TEXT REFERENCES publishing_publication_versions(id) ON DELETE RESTRICT,
  activation_type TEXT NOT NULL CHECK(activation_type IN ('initial','update','schedule','rollback','staff')),
  actor_user_id TEXT,
  reason_code TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_publishing_publication_activations_lifecycle
  ON publishing_publication_activations(lifecycle_id,created_at DESC);
CREATE INDEX idx_publishing_publication_activations_version
  ON publishing_publication_activations(publication_version_id,created_at DESC);

CREATE TABLE staff_audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  target_user_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('principal_bootstrapped','principal_updated','roles_changed','principal_suspended','principal_reactivated','principal_disabled')),
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_staff_audit_target ON staff_audit_events(target_user_id,created_at DESC);
CREATE INDEX idx_staff_audit_actor ON staff_audit_events(actor_user_id,created_at DESC);

CREATE TRIGGER trg_publishing_activation_no_update BEFORE UPDATE ON publishing_publication_activations BEGIN
  SELECT RAISE(ABORT,'publication activation history is append-only');
END;
CREATE TRIGGER trg_publishing_activation_no_delete BEFORE DELETE ON publishing_publication_activations BEGIN
  SELECT RAISE(ABORT,'publication activation history is append-only');
END;
CREATE TRIGGER trg_staff_audit_no_update BEFORE UPDATE ON staff_audit_events BEGIN
  SELECT RAISE(ABORT,'staff access audit is append-only');
END;
CREATE TRIGGER trg_staff_audit_no_delete BEFORE DELETE ON staff_audit_events BEGIN
  SELECT RAISE(ABORT,'staff access audit is append-only');
END;
