-- External audio is a distinct trust boundary from Wikimedia Commons discovery.
-- No existing track or source is automatically granted playback by this migration.
CREATE TABLE IF NOT EXISTS soundtrack_external_recordings (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('fma','musopen')),
  source_page_url TEXT NOT NULL UNIQUE,
  source_file_sha1 TEXT NOT NULL,
  source_file_sha256 TEXT NOT NULL UNIQUE,
  source_size INTEGER NOT NULL CHECK(source_size BETWEEN 1 AND 26214400),
  mime TEXT NOT NULL CHECK(mime IN ('audio/ogg','audio/mpeg')),
  title TEXT NOT NULL,
  performer TEXT NOT NULL,
  composer TEXT NOT NULL,
  license_code TEXT NOT NULL CHECK(license_code IN ('PD','CC0','CC-BY','CC-BY-SA')),
  license_url TEXT NOT NULL,
  license_statement TEXT NOT NULL,
  attribution_text TEXT NOT NULL,
  period TEXT NOT NULL,
  instruments_json TEXT NOT NULL,
  moods_json TEXT NOT NULL,
  energy REAL NOT NULL CHECK(energy >= 0 AND energy <= 1),
  has_vocals INTEGER NOT NULL CHECK(has_vocals IN (0,1)),
  territories_json TEXT NOT NULL DEFAULT '["US"]',
  provenance_json TEXT NOT NULL,
  provenance_sha256 TEXT NOT NULL,
  quality_report_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK(status IN ('pending_review','staged','ready','rejected','revoked')),
  storage_key TEXT UNIQUE,
  storage_bytes INTEGER,
  registered_by TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS soundtrack_external_public ON soundtrack_external_recordings(status,period,id);
CREATE INDEX IF NOT EXISTS soundtrack_external_review ON soundtrack_external_recordings(status,created_at);

CREATE TABLE IF NOT EXISTS soundtrack_external_events (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES soundtrack_external_recordings(id),
  actor TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('registered','uploaded','approved','revoked','rejected')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS soundtrack_external_history ON soundtrack_external_events(recording_id,created_at);
CREATE TRIGGER IF NOT EXISTS soundtrack_external_events_immutable_update BEFORE UPDATE ON soundtrack_external_events
BEGIN SELECT RAISE(ABORT,'External soundtrack history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS soundtrack_external_events_immutable_delete BEFORE DELETE ON soundtrack_external_events
BEGIN SELECT RAISE(ABORT,'External soundtrack history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS soundtrack_external_ready_guard BEFORE UPDATE OF status ON soundtrack_external_recordings
WHEN NEW.status='ready' AND (NEW.storage_key IS NULL OR NEW.reviewed_at IS NULL OR NEW.reviewed_by IS NULL OR NEW.storage_bytes!=NEW.source_size)
BEGIN SELECT RAISE(ABORT,'External soundtrack needs stored verified original and approval'); END;
