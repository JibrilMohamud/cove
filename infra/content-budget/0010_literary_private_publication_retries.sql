-- CONTENT_DB ONLY. Every finished inference is an implicit durable publication
-- intent. No primary rights or customer data are stored in this data plane.
-- Activate only after the private publisher Service Binding is provisioned.
ALTER TABLE literary_inference_jobs ADD COLUMN publication_state TEXT NOT NULL
  DEFAULT 'pending'
  CHECK(publication_state IN ('pending','running','published','held'));
ALTER TABLE literary_inference_jobs ADD COLUMN publication_available_at TEXT NOT NULL DEFAULT '';
ALTER TABLE literary_inference_jobs ADD COLUMN publication_lease_until TEXT NOT NULL DEFAULT '';
ALTER TABLE literary_inference_jobs ADD COLUMN publication_lease_token TEXT NOT NULL DEFAULT '';
ALTER TABLE literary_inference_jobs ADD COLUMN publication_attempts INTEGER NOT NULL DEFAULT 0
  CHECK(publication_attempts>=0);
ALTER TABLE literary_inference_jobs ADD COLUMN publication_last_error TEXT NOT NULL DEFAULT '';
ALTER TABLE literary_inference_jobs ADD COLUMN published_at TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_literary_inference_publication_due
  ON literary_inference_jobs(status,publication_state,publication_available_at,id);
CREATE INDEX IF NOT EXISTS idx_literary_inference_publication_expired
  ON literary_inference_jobs(status,publication_state,publication_lease_until);
