-- CONTENT_DB ONLY. Source rights and customer publication remain in canonical primary D1.
-- Install after 0001_ledger.sql, 0002_preparation_queue.sql and 0005 settlement receipts.
CREATE TABLE IF NOT EXISTS literary_inference_jobs (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=64),
  prepare_job_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  edition_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
  profile_fingerprint TEXT NOT NULL CHECK(length(profile_fingerprint)=64),
  profile_revision INTEGER NOT NULL CHECK(profile_revision>=0),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0 AND attempts<=3),
  available_at TEXT NOT NULL,
  lease_token TEXT NOT NULL DEFAULT '',
  lease_until TEXT NOT NULL DEFAULT '',
  result_key TEXT,
  result_sha256 TEXT CHECK(result_sha256 IS NULL OR length(result_sha256)=64),
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(prepare_job_id,profile_fingerprint)
);
CREATE INDEX IF NOT EXISTS literary_inference_due
  ON literary_inference_jobs(status,available_at,id);
CREATE INDEX IF NOT EXISTS literary_inference_expired
  ON literary_inference_jobs(status,lease_until,attempts);
CREATE INDEX IF NOT EXISTS literary_prepare_completed_for_inference
  ON literary_prepare_jobs(status,updated_at,id);
