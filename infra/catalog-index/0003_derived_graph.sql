-- Independent D1 only: metadata graph (never rights, offers or orders).
-- Bounded one-row-per-source compaction avoids an unbounded revision history.
CREATE TABLE IF NOT EXISTS catalog_graph_documents (
 source_id TEXT PRIMARY KEY NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>=0),
 visible INTEGER NOT NULL CHECK(visible IN (0,1)),
 work_id TEXT NOT NULL,
 edition_id TEXT NOT NULL,
 product_id TEXT NOT NULL,
 title TEXT NOT NULL,
 description TEXT NOT NULL,
 contributors_json TEXT NOT NULL DEFAULT '[]',
 subjects_json TEXT NOT NULL DEFAULT '[]',
 shelves_json TEXT NOT NULL DEFAULT '[]',
 languages_json TEXT NOT NULL DEFAULT '[]',
 assets_json TEXT NOT NULL DEFAULT '{}',
 source_name TEXT NOT NULL DEFAULT '',
 source_item_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_catalog_graph_product
 ON catalog_graph_documents(product_id) WHERE visible=1;
