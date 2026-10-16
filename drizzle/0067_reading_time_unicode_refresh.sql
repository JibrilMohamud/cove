-- Refresh measured reading counts independently of valid literary inference.
-- No AI jobs, source rights, or model profiles are invalidated by a counting fix.
UPDATE literary_profile_jobs
SET status='queued',attempts=0,available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),lease_token='',lease_until='',last_error='',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE kind='prepare' AND status IN ('done','failed')
AND EXISTS (
  SELECT 1 FROM literary_profiles p WHERE p.product_id=literary_profile_jobs.product_id
  AND p.fingerprint=literary_profile_jobs.fingerprint
  AND json_extract(p.reading_time_json,'$.policy')='cove-reading-time-v1'
  AND json_extract(p.reading_time_json,'$.method') IN ('epub_text','partial_text_lower_bound')
);
