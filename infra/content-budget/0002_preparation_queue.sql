-- Apply ONLY to the physically isolated literary CONTENT_DB. Never run
-- on primary D1 or as part of the storefront/rights migration chain.
CREATE TABLE IF NOT EXISTS literary_prepare_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL,
  edition_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0 AND attempts<=3),
  available_at TEXT NOT NULL,
  lease_token TEXT NOT NULL DEFAULT '',
  lease_until TEXT NOT NULL DEFAULT '',
  result_key TEXT,
  result_sha256 TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS literary_prepare_queued_frontier
  ON literary_prepare_jobs(status,available_at,id);
-- Marker is a binding identity, NOT evidence of customer entitlement.
-- Existing CONTENT_DB schema version 1 identity remains authoritative.
