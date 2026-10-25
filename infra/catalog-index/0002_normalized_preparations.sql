-- Second migration in the independent D1 only. No customer/rights tables.
-- Revisions are canonical SOURCE feed sequence numbers; no rights or prices.
CREATE TABLE IF NOT EXISTS catalog_normalized_preparations (
 source_id TEXT PRIMARY KEY NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>=0),
 visible INTEGER NOT NULL CHECK(visible IN (0,1)),
 source_title TEXT,
 source_summary TEXT,
 title TEXT NOT NULL DEFAULT '',
 description TEXT NOT NULL DEFAULT ''
);
