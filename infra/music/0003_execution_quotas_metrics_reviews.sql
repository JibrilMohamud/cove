-- ONLY apply to the detached MUSIC_DB. No customer primary D1 or serving schemas.
CREATE TABLE IF NOT EXISTS music_source_limits (
  contract_id TEXT PRIMARY KEY REFERENCES music_contracts(id),
  paused INTEGER NOT NULL DEFAULT 1 CHECK(paused IN (0,1)),
  daily_intake_limit INTEGER NOT NULL DEFAULT 20 CHECK(daily_intake_limit BETWEEN 1 AND 1000),
  parallel_intake_limit INTEGER NOT NULL DEFAULT 2 CHECK(parallel_intake_limit BETWEEN 1 AND 16),
  daily_analysis_limit INTEGER NOT NULL DEFAULT 40 CHECK(daily_analysis_limit BETWEEN 1 AND 2000),
  parallel_analysis_limit INTEGER NOT NULL DEFAULT 2 CHECK(parallel_analysis_limit BETWEEN 1 AND 16),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS music_intake_jobs (
  master_id TEXT PRIMARY KEY REFERENCES music_masters(id),
  contract_id TEXT NOT NULL REFERENCES music_contracts(id),
  master_sha256 TEXT NOT NULL CHECK(length(master_sha256)=64),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  available_at TEXT NOT NULL,
  lease_token TEXT NOT NULL DEFAULT '',
  lease_until TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS music_intake_claim
  ON music_intake_jobs(status,available_at,lease_until,contract_id,master_id);
CREATE TABLE IF NOT EXISTS music_stage_events (
  event_key TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  master_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('intake_claim','intake_complete','analysis_claim','analysis_complete','analysis_failed','human_approved','human_rejected')),
  outcome TEXT NOT NULL,
  processing_ms INTEGER CHECK(processing_ms IS NULL OR processing_ms BETWEEN 0 AND 1800000),
  cost_microusd INTEGER CHECK(cost_microusd IS NULL OR cost_microusd BETWEEN 0 AND 100000000),
  bytes_processed INTEGER NOT NULL DEFAULT 0 CHECK(bytes_processed >= 0),
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS music_stage_daily
  ON music_stage_events(stage,recorded_at,contract_id);
CREATE INDEX IF NOT EXISTS music_stage_by_source
  ON music_stage_events(contract_id,stage,recorded_at);
CREATE TABLE IF NOT EXISTS music_human_reviews (
  master_id TEXT NOT NULL,
  policy TEXT NOT NULL,
  master_sha256 TEXT NOT NULL CHECK(length(master_sha256)=64),
  report_sha256 TEXT NOT NULL CHECK(length(report_sha256)=64),
  decision TEXT NOT NULL CHECK(decision IN ('approve','reject')),
  reviewer_id TEXT NOT NULL,
  rationale TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  PRIMARY KEY(master_id,policy)
);
