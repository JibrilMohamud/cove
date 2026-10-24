-- CONTENT_DB ONLY: opt-in, cursor-bounded legacy job reconciliation.
-- Disarmed until an operator has fenced and drained all primary legacy workers.
-- Never store rights grants, customer data, or source authorization here.
CREATE TABLE IF NOT EXISTS literary_legacy_reconcile_frontier (
  id INTEGER PRIMARY KEY CHECK(id=1),
  status TEXT NOT NULL DEFAULT 'disarmed'
    CHECK(status IN ('disarmed','armed','complete')),
  after_job_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO literary_legacy_reconcile_frontier(id) VALUES(1);

CREATE TABLE IF NOT EXISTS literary_legacy_reconcile_receipts (
  legacy_job_id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL,
  profile_fingerprint TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('seeded','held')),
  outbox_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  CHECK(
    (disposition='seeded' AND outbox_id IS NOT NULL) OR
    (disposition='held' AND outbox_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS literary_legacy_reconcile_disposition
  ON literary_legacy_reconcile_receipts(disposition,legacy_job_id);
