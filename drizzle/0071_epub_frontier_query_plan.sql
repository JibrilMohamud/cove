-- The asset runner now claims separate 'pending' and 'retry' lanes.
-- The old partial frontier required a literal IN('pending','retry') clause,
-- so a parameterized epub_status=? probe could not reliably use that index.
-- This index preserves the source + due-time ordering without sorting 40k+ rows.
-- Retain the ingest_status predicate: quarantined rights/assets must stay excluded.
CREATE INDEX IF NOT EXISTS gutenberg_asset_frontier_v2
  ON gutenberg_source_cache(source_id,epub_status,epub_next_attempt_at,updated_at,id)
  WHERE ingest_status<>'quarantined';
-- All former indexed columns and eligible statuses remain covered; avoid
-- paying two write-amplification penalties for the same stored asset queue.
DROP INDEX IF EXISTS gutenberg_asset_frontier;
