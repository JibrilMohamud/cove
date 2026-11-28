-- Detached snapshot transfer receipt only. No production binding or customer rows.
CREATE TABLE IF NOT EXISTS cove_snapshot_copy_receipt (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  run_id TEXT NOT NULL, run_attempt TEXT NOT NULL, sha TEXT NOT NULL,
  transfer_digest TEXT NOT NULL, manifest_digest TEXT NOT NULL,
  products INTEGER NOT NULL CHECK(products>=82247),
  editions INTEGER NOT NULL CHECK(editions=products),
  completed_at TEXT NOT NULL
);
