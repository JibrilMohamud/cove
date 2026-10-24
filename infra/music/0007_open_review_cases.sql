-- MUSIC_DB ONLY. A review case is never a recording license or playable master.
-- Even a review completed elsewhere must NOT mutate this non-authoritative table
-- into approval. The canonical rights and playback gates remain independent.
CREATE TABLE IF NOT EXISTS music_open_review_cases (
  candidate_id TEXT NOT NULL REFERENCES music_open_source_candidates(id),
  review_kind TEXT NOT NULL CHECK(review_kind IN ('rights_provenance','quiet_suitability')),
  source_sha1 TEXT NOT NULL CHECK(length(source_sha1)=40),
  original_sha256 TEXT NOT NULL CHECK(length(original_sha256)=64),
  technical_report_sha256 TEXT NOT NULL CHECK(length(technical_report_sha256)=64),
  discovery_evidence_sha256 TEXT NOT NULL CHECK(length(discovery_evidence_sha256)=64),
  reason TEXT NOT NULL CHECK(reason IN (
    'recording_license_upstream_reconciliation',
    'human_acoustic_quiet_calibration'
  )),
  status TEXT NOT NULL DEFAULT 'needs_review' CHECK(status='needs_review'),
  attribution_draft TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(candidate_id,review_kind),
  CHECK (
    (review_kind='rights_provenance' AND reason='recording_license_upstream_reconciliation') OR
    (review_kind='quiet_suitability' AND reason='human_acoustic_quiet_calibration')
  )
);
CREATE INDEX IF NOT EXISTS music_open_review_kind_status
 ON music_open_review_cases(review_kind,status,recorded_at,candidate_id);
-- Evidence is append-only. Superseded source revisions require a new
-- technical evaluation, not an in-place mutation of the old review receipt.
CREATE TRIGGER IF NOT EXISTS music_open_review_cases_no_update
 BEFORE UPDATE ON music_open_review_cases
 BEGIN SELECT RAISE(ABORT, 'immutable_open_review_case'); END;
CREATE TRIGGER IF NOT EXISTS music_open_review_cases_no_delete
 BEFORE DELETE ON music_open_review_cases
 BEGIN SELECT RAISE(ABORT, 'immutable_open_review_case'); END;
