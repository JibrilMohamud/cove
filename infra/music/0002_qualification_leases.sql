-- Detached MUSIC_DB only. This migration never touches Cove's customer D1.
-- One immutable master has one versioned qualification task; old receipts are
-- never reusable after the source SHA or acoustic policy changes.
CREATE TABLE IF NOT EXISTS music_analysis_jobs (
  master_id TEXT NOT NULL REFERENCES music_masters(id),
  policy TEXT NOT NULL,
  master_sha256 TEXT NOT NULL CHECK(length(master_sha256)=64),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','approved','needs_review','rejected','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  available_at TEXT NOT NULL,
  lease_token TEXT NOT NULL DEFAULT '',
  lease_until TEXT NOT NULL DEFAULT '',
  report_key TEXT,
  report_sha256 TEXT,
  tier TEXT,
  reasons_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(reasons_json)),
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(master_id,policy)
);
CREATE INDEX IF NOT EXISTS music_analysis_claim
  ON music_analysis_jobs(policy,status,available_at,lease_until,master_id);
CREATE INDEX IF NOT EXISTS music_analysis_qualified
  ON music_analysis_jobs(policy,status,master_sha256,master_id);
