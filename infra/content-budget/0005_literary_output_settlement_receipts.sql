-- Receipt ledger is transactional with the daily reservation balance.
-- Same schema is installed in canonical and isolated literary-budget D1.
-- No runtime feature flags are changed by this migration.
CREATE TABLE IF NOT EXISTS literary_output_settlement_receipts (
  receipt_key TEXT PRIMARY KEY NOT NULL,
  day TEXT NOT NULL,
  refund_units INTEGER NOT NULL CHECK(refund_units>=0),
  applied INTEGER NOT NULL DEFAULT 0 CHECK(applied IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_literary_output_settlement_day
  ON literary_output_settlement_receipts(day);
