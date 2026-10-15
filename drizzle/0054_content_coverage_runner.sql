-- Durable singleton admission and cumulative outcomes; no private reader data.
CREATE TABLE IF NOT EXISTS catalog_asset_runner (
  id INTEGER PRIMARY KEY CHECK(id=1),
  lease_token TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  attempted INTEGER NOT NULL DEFAULT 0,
  stored INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  last_result_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS gutenberg_asset_due ON gutenberg_source_cache(epub_status,ingest_status,epub_next_attempt_at,source_id);
CREATE INDEX IF NOT EXISTS gutenberg_asset_frontier ON gutenberg_source_cache(source_id,epub_status DESC,epub_next_attempt_at,updated_at,id)
  WHERE ingest_status<>'quarantined' AND epub_status IN ('pending','retry');

ALTER TABLE gutenberg_source_states ADD COLUMN epub_retry_after TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS audio_media_checks (
  edition_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  audio_sha256 TEXT NOT NULL,
  epub_sha256 TEXT NOT NULL DEFAULT '',
  timing_sha256 TEXT NOT NULL DEFAULT '',
  audio_present INTEGER NOT NULL CHECK(audio_present IN (0,1)),
  timing_present INTEGER NOT NULL CHECK(timing_present IN (0,1)),
  checked_at TEXT NOT NULL,
  PRIMARY KEY(edition_id,track_id)
);
CREATE INDEX IF NOT EXISTS audio_media_checks_age ON audio_media_checks(checked_at);
