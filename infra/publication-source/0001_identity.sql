-- Independent catalog-presentation source ONLY. Never apply to Cove's
-- canonical rights/commerce D1 or the publication ledger D1.
-- A source-replication owner must atomically commit a complete compatible
-- public-catalog snapshot before inserting/updating this identity row.
-- The exporter refuses an absent/stale identity (at most 2 minutes old).
-- No customer, entitlement, payment, rights, or identity tables belong here.
CREATE TABLE IF NOT EXISTS cove_publication_source_identity (
  id INTEGER PRIMARY KEY CHECK(id=1),
  domain TEXT NOT NULL CHECK(domain='cove-independent-publication-source'),
  last_synced_at INTEGER NOT NULL CHECK(last_synced_at>0)
);

CREATE TABLE IF NOT EXISTS cove_publication_source_snapshots (
  country TEXT PRIMARY KEY NOT NULL CHECK(length(country)=2),
  generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>0),
  body TEXT NOT NULL CHECK(length(body)>2 AND length(body)<=524288),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  created_at INTEGER NOT NULL CHECK(created_at>0),
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at)
);
CREATE INDEX IF NOT EXISTS idx_cove_publication_snapshots_expiry
ON cove_publication_source_snapshots(expires_at,country);

CREATE TABLE IF NOT EXISTS cove_publication_source_progress (
  id INTEGER PRIMARY KEY CHECK(id=1),
  owner TEXT NOT NULL DEFAULT '',
  lease_until INTEGER NOT NULL DEFAULT 0,
  cursor TEXT NOT NULL DEFAULT '',
  expected_markets INTEGER NOT NULL DEFAULT 0,
  last_full_cycle_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO cove_publication_source_progress(id) VALUES(1);
