-- PRIMARY D1 schema prerequisite for a future explicit, rights-guarded
-- import of private literary preparation receipts. DO NOT auto-apply to
-- production. This is a non-customer-visible operational projection.
CREATE TABLE IF NOT EXISTS literary_prepared_evidence (
  product_id TEXT NOT NULL,
  edition_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  evidence_key TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (product_id,source_sha256)
);
CREATE INDEX IF NOT EXISTS idx_literary_prepared_evidence_recent
ON literary_prepared_evidence(imported_at,product_id);
