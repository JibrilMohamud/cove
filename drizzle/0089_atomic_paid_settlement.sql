-- A receipt is committed in the SAME D1 batch as tender, fulfillment and the
-- balanced sale journal. verified=0 deliberately aborts the complete batch.
-- This is a recovery marker, never a grant of permission to deliver media.
CREATE TABLE IF NOT EXISTS commerce_settlement_receipts (
  order_id TEXT PRIMARY KEY NOT NULL REFERENCES commerce_orders(id) ON DELETE RESTRICT,
  payment_reference TEXT NOT NULL,
  payment_json TEXT NOT NULL,
  verified INTEGER NOT NULL CHECK(verified=1),
  settled_at TEXT NOT NULL,
  effects_completed_at TEXT,
  owner_published_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_settlement_receipts_pending
  ON commerce_settlement_receipts(settled_at,order_id)
  WHERE owner_published_at IS NULL;
