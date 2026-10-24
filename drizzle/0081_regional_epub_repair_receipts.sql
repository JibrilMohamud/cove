-- Primary D1: durable, rights-rechecked recovery of partial regional asset repairs.
-- No ownership rights or contents are copied into this ledger.
CREATE TABLE IF NOT EXISTS regional_epub_repair_receipts(
  source_id TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  edition_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','completed')),
  verified_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY(source_id,content_hash)
);
CREATE INDEX IF NOT EXISTS regional_epub_repair_pending
ON regional_epub_repair_receipts(status,source_id)
WHERE status='pending';
