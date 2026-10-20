-- PRIMARY D1 ONLY: explicit, bounded handoff intents.
-- Release gated: do not put in standard production migrations or enable
-- the handoff Worker before independent capacity and rights tests.
CREATE TABLE IF NOT EXISTS literary_prepare_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL,
  edition_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','delivered','cancelled','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0 AND attempts<=4),
  available_at TEXT NOT NULL,
  lease_token TEXT NOT NULL DEFAULT '',
  lease_until TEXT NOT NULL DEFAULT '',
  delivered_job_id TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_literary_prepare_outbox_frontier
  ON literary_prepare_outbox(status,available_at,id);
