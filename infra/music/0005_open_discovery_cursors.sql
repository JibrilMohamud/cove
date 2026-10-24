-- Additive, detached QA MUSIC_DB only. Persist MediaWiki's opaque
-- categorymembers generator continuation. No customer catalog, rights grant,
-- raw master, entitlement or playback state is created here.
CREATE TABLE IF NOT EXISTS music_open_discovery_cursors (
  source TEXT NOT NULL DEFAULT 'commons' CHECK(source='commons'),
  category TEXT NOT NULL PRIMARY KEY CHECK(length(category) BETWEEN 12 AND 160),
  generator_cursor TEXT NOT NULL DEFAULT '' CHECK(length(generator_cursor)<=2048),
  updated_at TEXT NOT NULL,
  last_run_id TEXT NOT NULL,
  CHECK(length(last_run_id) BETWEEN 1 AND 80)
);
CREATE INDEX IF NOT EXISTS music_open_discovery_cursors_updated
  ON music_open_discovery_cursors(updated_at);
