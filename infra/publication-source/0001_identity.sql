-- Independent catalog-presentation source ONLY. Never apply to Cove's
-- canonical rights/commerce D1 or the publication ledger D1.
-- A source-replication owner must atomically commit a complete compatible
-- public-catalog snapshot before inserting/updating this identity row.
-- The exporter refuses an absent/stale identity (< 2 minutes freshness).
CREATE TABLE IF NOT EXISTS cove_publication_source_identity (
  id INTEGER PRIMARY KEY CHECK(id=1),
  domain TEXT NOT NULL CHECK(domain='cove-independent-publication-source'),
  last_synced_at INTEGER NOT NULL CHECK(last_synced_at>0)
);
