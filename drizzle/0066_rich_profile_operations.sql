ALTER TABLE literary_profiles ADD COLUMN reading_time_json TEXT;
ALTER TABLE literary_profiles ADD COLUMN policy_version TEXT NOT NULL DEFAULT '';
ALTER TABLE literary_profile_sections ADD COLUMN reading_time_json TEXT;
ALTER TABLE literary_profile_state ADD COLUMN inference_turn INTEGER NOT NULL DEFAULT 0;
-- Inference and extraction have separate lanes. Budget exhaustion cannot block text counts.
CREATE INDEX idx_literary_job_lane ON literary_profile_jobs(kind,status,available_at,created_at);
UPDATE literary_profile_state SET cursor='';
-- A policy change invalidates pending inference, while preserving prior evidence/revisions.
UPDATE literary_profile_jobs SET status='superseded',lease_until='' WHERE status IN ('queued','running');

CREATE TABLE music_profiles (
  recording_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  policy TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'provisional' CHECK(status IN ('provisional','analyzed','failed')),
  profile_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE music_profile_jobs (
  recording_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_token TEXT NOT NULL DEFAULT '',
  lease_until TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_music_jobs_due ON music_profile_jobs(status,available_at,recording_id);
CREATE TABLE music_profile_revisions (
  recording_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  report_key TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(recording_id,fingerprint)
);
CREATE TABLE music_profile_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  cursor TEXT NOT NULL DEFAULT '',
  lease_token TEXT NOT NULL DEFAULT '',
  lease_until TEXT NOT NULL DEFAULT ''
);
INSERT INTO music_profile_state(id) VALUES(1);

CREATE TRIGGER music_profile_revision_no_update BEFORE UPDATE ON music_profile_revisions
BEGIN SELECT RAISE(ABORT,'Music profile revisions are append-only'); END;
CREATE TRIGGER music_profile_revision_no_delete BEFORE DELETE ON music_profile_revisions
BEGIN SELECT RAISE(ABORT,'Music profile revisions are append-only'); END;
