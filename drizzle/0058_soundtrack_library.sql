-- Soundtrack recordings are NOT audiobooks. A Commons license tag is discovery evidence,
-- not independent verification that both the composition and recording can be hosted.
CREATE TABLE IF NOT EXISTS soundtrack_recordings (
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
  license_code TEXT NOT NULL CHECK(license_code IN ('CC0','CC-BY','PD')),
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
CREATE INDEX IF NOT EXISTS soundtrack_rights_queue ON soundtrack_recordings(status,discovered_at);
CREATE INDEX IF NOT EXISTS soundtrack_public ON soundtrack_recordings(status,period,id);
CREATE TABLE IF NOT EXISTS soundtrack_ingestion_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  category_index INTEGER NOT NULL DEFAULT 0,
  continuation TEXT NOT NULL DEFAULT '',
  discovered INTEGER NOT NULL DEFAULT 0,
  downloaded INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  last_discovery_at TEXT NOT NULL DEFAULT '',
  last_import_at TEXT NOT NULL DEFAULT '',
  lease_token TEXT NOT NULL DEFAULT '',
  lease_until TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO soundtrack_ingestion_state(id) VALUES(1);
