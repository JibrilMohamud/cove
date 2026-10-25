-- Append-only, primary-owned *notification* outbox; no catalogue text,
-- Meilisearch upload, FTS tokenisation or external I/O on the rights D1.
-- Rights checks never consume this feed as authority.
CREATE TABLE IF NOT EXISTS catalog_index_changefeed (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_catalog_index_changefeed_id ON catalog_index_changefeed(cache_id,seq);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS catalog_index_source_ai
AFTER INSERT ON gutenberg_source_cache BEGIN
 INSERT INTO catalog_index_changefeed(cache_id,operation) VALUES(new.id,'upsert');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS catalog_index_source_au
AFTER UPDATE OF title,summary,authors_json,subjects_json,bookshelves_json,languages_json,
 formats_json,rights_status,commercial_use_status,ingest_status,copyright
ON gutenberg_source_cache BEGIN
 INSERT INTO catalog_index_changefeed(cache_id,operation) VALUES(new.id,'upsert');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS catalog_index_source_ad
AFTER DELETE ON gutenberg_source_cache BEGIN
 INSERT INTO catalog_index_changefeed(cache_id,operation) VALUES(old.id,'delete');
END;
