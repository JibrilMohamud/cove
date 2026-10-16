-- Content profiles are edition-specific; translations and revisions keep separate evidence.
CREATE TABLE literary_profiles (
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('provisional','analyzed','partial','failed')),
  coverage TEXT NOT NULL DEFAULT 'metadata',
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE literary_profile_jobs (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('prepare','analyze')),
  section_id TEXT NOT NULL DEFAULT '',
  source_key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed','superseded')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_token TEXT NOT NULL DEFAULT '',
  lease_until TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(product_id,fingerprint,kind,section_id)
);
CREATE INDEX idx_literary_jobs_due ON literary_profile_jobs(status,available_at,id);
CREATE INDEX idx_literary_jobs_product ON literary_profile_jobs(product_id,fingerprint,status);
CREATE TABLE literary_profile_sections (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  section_id TEXT NOT NULL,
  spine_index INTEGER NOT NULL,
  href TEXT NOT NULL,
  title TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  source_key TEXT NOT NULL,
  profile_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(product_id,fingerprint,section_id)
);
CREATE TABLE literary_profile_revisions (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  model TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(product_id,revision)
);
CREATE TABLE literary_profile_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  cursor TEXT NOT NULL DEFAULT '',
  lease_token TEXT NOT NULL DEFAULT '',
  lease_until TEXT NOT NULL DEFAULT '',
  last_run_at TEXT NOT NULL DEFAULT ''
);
INSERT INTO literary_profile_state(id) VALUES(1);
CREATE TABLE literary_profile_budget (
  day TEXT PRIMARY KEY,
  reserved_units INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0
);
-- Modern reconstruction and recording date never substitute for composition date.
CREATE TABLE soundtrack_context (
  recording_id TEXT PRIMARY KEY,
  composition_start_year INTEGER,
  composition_end_year INTEGER,
  recording_start_year INTEGER,
  recording_end_year INTEGER,
  reconstruction INTEGER CHECK(reconstruction IN (0,1)),
  evoked_eras_json TEXT NOT NULL DEFAULT '[]',
  geography_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  CHECK(composition_end_year>=composition_start_year),
  CHECK(recording_end_year>=recording_start_year)
);
-- Staff-supplied, permission-backed excerpts/reviews; never scrape a review provider.
CREATE TABLE literary_profile_sources (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('description','excerpt','review')),
  locator TEXT NOT NULL,
  text TEXT NOT NULL CHECK(length(text)<=12000),
  content_sha256 TEXT NOT NULL,
  permission_basis TEXT NOT NULL,
  supplied_by TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_literary_sources_product ON literary_profile_sources(product_id,active,id);
