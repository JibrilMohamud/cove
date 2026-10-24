-- Detached MUSIC_DB only. Openverse is discovery, not licensing authority.
-- These records are evidence candidates, never contract authorizations or
-- playable music. No customer D1 tables, outbox events, entitlements or releases.
CREATE TABLE IF NOT EXISTS music_open_source_candidates (
  id TEXT PRIMARY KEY CHECK(id GLOB 'cm_*'),
  discovery_provider TEXT NOT NULL CHECK(discovery_provider IN ('openverse','commons')),
  source_page_url TEXT NOT NULL,
  source_file_url TEXT NOT NULL,
  source_title TEXT NOT NULL,
  source_sha1 TEXT NOT NULL CHECK(length(source_sha1)=40),
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 128 AND 26214400),
  license_code TEXT NOT NULL CHECK(license_code IN ('CC0','CC-BY','CC-BY-SA')),
  license_url TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
  status TEXT NOT NULL DEFAULT 'discovered' CHECK(status IN ('discovered','held')),
  hold_reason TEXT NOT NULL DEFAULT '',
  discovered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS music_open_candidates_sha1
 ON music_open_source_candidates(source_sha1,status);
CREATE INDEX IF NOT EXISTS music_open_candidates_status
 ON music_open_source_candidates(status,discovered_at,id);
CREATE TABLE IF NOT EXISTS music_open_discovery_runs (
  run_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('openverse','commons')),
  searches INTEGER NOT NULL CHECK(searches BETWEEN 0 AND 5),
  verified INTEGER NOT NULL CHECK(verified BETWEEN 0 AND 32),
  discovered INTEGER NOT NULL CHECK(discovered BETWEEN 0 AND 32),
  processing_ms INTEGER NOT NULL CHECK(processing_ms BETWEEN 0 AND 1800000),
  estimated_cost_microusd INTEGER,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS music_open_runs_day
 ON music_open_discovery_runs(recorded_at,provider);
