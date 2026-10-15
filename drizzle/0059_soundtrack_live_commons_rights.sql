-- Allow reviewed, unmodified BY-SA commercial recordings; retain original
-- license edition and attribution obligations in the evidence snapshot.
-- Metadata stage remains unapproved even for CC0/PD claims.
PRAGMA foreign_keys=OFF;
CREATE TABLE soundtrack_recordings_revised (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'wikimedia_commons' CHECK(source='wikimedia_commons'),
  source_title TEXT NOT NULL UNIQUE,
  source_page_url TEXT NOT NULL,
  source_file_url TEXT NOT NULL,
  source_sha1 TEXT NOT NULL,
  source_size INTEGER NOT NULL CHECK(source_size BETWEEN 1 AND 26214400),
  mime TEXT NOT NULL CHECK(mime IN ('audio/ogg','audio/mpeg')),
  title TEXT NOT NULL,
  performer TEXT NOT NULL DEFAULT '',
  composer TEXT NOT NULL DEFAULT '',
  license_code TEXT NOT NULL CHECK(license_code IN ('CC0','CC-BY','CC-BY-SA','PD')),
  license_url TEXT NOT NULL,
  license_statement TEXT NOT NULL,
  attribution_text TEXT NOT NULL,
  period TEXT NOT NULL DEFAULT 'unknown',
  instruments_json TEXT NOT NULL DEFAULT '[]',
  moods_json TEXT NOT NULL DEFAULT '[]',
  energy REAL CHECK(energy IS NULL OR (energy>=0 AND energy<=1)),
  has_vocals INTEGER CHECK(has_vocals IN (0,1)),
  tag_source TEXT NOT NULL DEFAULT 'heuristic',
  evidence_json TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  review_evidence TEXT,
  allowed_territories_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK(status IN ('pending_review','approved','importing','ready','rejected','revoked','import_failed')),
  storage_key TEXT UNIQUE,
  storage_sha1 TEXT,
  storage_bytes INTEGER,
  stored_at TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO soundtrack_recordings_revised SELECT * FROM soundtrack_recordings;
DROP TABLE soundtrack_recordings;
ALTER TABLE soundtrack_recordings_revised RENAME TO soundtrack_recordings;
CREATE INDEX soundtrack_rights_queue ON soundtrack_recordings(status,discovered_at);
CREATE INDEX soundtrack_public ON soundtrack_recordings(status,period,id);
PRAGMA foreign_keys=ON;
ALTER TABLE soundtrack_ingestion_state ADD COLUMN category_cursors_json TEXT NOT NULL DEFAULT '{}';

-- An immutable decision timeline, including source hashes and references, without exposing
-- reviewers' personal information in public endpoints.
CREATE TABLE IF NOT EXISTS soundtrack_rights_decisions (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES soundtrack_recordings(id),
  principal_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('approve','reject','revoke','retry')),
  evidence_json TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS soundtrack_rights_history ON soundtrack_rights_decisions(recording_id,decided_at);
