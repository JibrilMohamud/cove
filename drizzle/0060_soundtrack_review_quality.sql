-- No approvals are granted by migration. Existing files must pass measured QA.
ALTER TABLE soundtrack_recordings ADD COLUMN dossier_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE soundtrack_recordings ADD COLUMN quality_report_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE soundtrack_recordings ADD COLUMN quality_status TEXT NOT NULL DEFAULT 'pending'
  CHECK(quality_status IN ('pending','passed','failed'));
ALTER TABLE soundtrack_recordings ADD COLUMN source_snapshot_key TEXT;
ALTER TABLE soundtrack_recordings ADD COLUMN review_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE soundtrack_recordings ADD COLUMN last_import_error TEXT NOT NULL DEFAULT '';
CREATE TABLE soundtrack_review_events (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES soundtrack_recordings(id),
  principal_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  source_sha1 TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX soundtrack_review_event_history ON soundtrack_review_events(recording_id,created_at,id);
CREATE TRIGGER soundtrack_review_event_no_update BEFORE UPDATE ON soundtrack_review_events
BEGIN SELECT RAISE(ABORT,'Soundtrack review events are append-only'); END;
CREATE TRIGGER soundtrack_review_event_no_delete BEFORE DELETE ON soundtrack_review_events
BEGIN SELECT RAISE(ABORT,'Soundtrack review events are append-only'); END;
CREATE TRIGGER soundtrack_decision_no_update BEFORE UPDATE ON soundtrack_rights_decisions
BEGIN SELECT RAISE(ABORT,'Soundtrack rights decisions are append-only'); END;
CREATE TRIGGER soundtrack_decision_no_delete BEFORE DELETE ON soundtrack_rights_decisions
BEGIN SELECT RAISE(ABORT,'Soundtrack rights decisions are append-only'); END;
CREATE TRIGGER soundtrack_ready_requires_evidence BEFORE UPDATE OF status ON soundtrack_recordings
WHEN NEW.status='ready' AND (NEW.quality_status!='passed' OR NEW.source_snapshot_key IS NULL
  OR NEW.reviewed_at IS NULL OR NEW.storage_sha1!=NEW.source_sha1 OR NEW.storage_bytes!=NEW.source_size
  OR NEW.storage_key IS NULL OR NEW.storage_sha1 IS NULL OR NEW.storage_bytes IS NULL)
BEGIN SELECT RAISE(ABORT,'Reviewed source evidence and audio QA required before publication'); END;

CREATE TABLE soundtrack_cleanup_queue (
  storage_key TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX soundtrack_unique_active_file ON soundtrack_recordings(source_sha1)
  WHERE status IN ('approved','importing','ready');
