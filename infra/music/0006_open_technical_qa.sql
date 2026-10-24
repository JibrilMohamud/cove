-- MUSIC_DB ONLY. A technical recording QA receipt is NOT a rights grant.
-- Neither this table nor its lifecycle can publish, entitle, or authorize playback.
CREATE TABLE IF NOT EXISTS music_open_technical_qa (
  candidate_id TEXT PRIMARY KEY REFERENCES music_open_source_candidates(id),
  source_sha1 TEXT NOT NULL CHECK(length(source_sha1)=40),
  source_sha256 TEXT CHECK(source_sha256 IS NULL OR length(source_sha256)=64),
  original_bytes INTEGER,
  source_evidence_sha256 TEXT NOT NULL CHECK(length(source_evidence_sha256)=64),
  audio_r2_key TEXT,
  report_r2_key TEXT,
  report_sha256 TEXT CHECK(report_sha256 IS NULL OR length(report_sha256)=64),
  status TEXT NOT NULL CHECK(status IN ('measured','held')),
  hold_reason TEXT NOT NULL DEFAULT '',
  rights_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK(rights_status='unreviewed'),
  quiet_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK(quiet_status='unreviewed'),
  measured_at TEXT NOT NULL,
  CHECK(
    (status='measured' AND source_sha256 IS NOT NULL AND original_bytes>=128
     AND audio_r2_key IS NOT NULL AND report_r2_key IS NOT NULL
     AND report_sha256 IS NOT NULL AND hold_reason='') OR
    (status='held' AND audio_r2_key IS NULL AND report_r2_key IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS music_open_qa_status
 ON music_open_technical_qa(status,measured_at,candidate_id);
