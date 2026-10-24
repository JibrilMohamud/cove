-- CANONICAL PRIMARY D1 ONLY. Staging operator prerequisite for legacy cutover.
-- Do NOT include this in regular production migrations or run during peak traffic.
-- Limits catch-up keyset reads to unfinished legacy job identities.
CREATE INDEX IF NOT EXISTS idx_literary_legacy_reconcile
  ON literary_profile_jobs(id)
  WHERE status IN ('queued','failed','running');

-- Lease probe stays indexed while the operator waits for in-flight writers.
CREATE INDEX IF NOT EXISTS idx_literary_legacy_active_lease
  ON literary_profile_jobs(lease_until,id)
  WHERE status='running';
