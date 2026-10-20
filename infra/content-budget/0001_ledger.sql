-- Execute ONLY against an independent, separately provisioned CONTENT_DB D1.
-- Never apply as part of production catalog migrations.
CREATE TABLE IF NOT EXISTS literary_profile_budget(
  day TEXT PRIMARY KEY NOT NULL,
  reserved_units INTEGER NOT NULL DEFAULT 0 CHECK(reserved_units>=0),
  calls INTEGER NOT NULL DEFAULT 0 CHECK(calls>=0)
);
CREATE TABLE IF NOT EXISTS literary_budget_cutover(
  day TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('prepared','active','closed')),
  original_reserved_units INTEGER NOT NULL CHECK(original_reserved_units>=0),
  original_calls INTEGER NOT NULL CHECK(original_calls>=0),
  prepared_at TEXT NOT NULL,
  activated_at TEXT,
  operator_receipt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_literary_budget_cutover_status
ON literary_budget_cutover(status,day);
