-- Append-only, primary-owned *notification* outbox; no catalogue text,
-- Meilisearch upload, FTS tokenisation or external I/O on the rights D1.
-- Rights checks never consume this feed as authority.
CREATE TABLE IF NOT EXISTS catalog_index_changefeed (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Seq is already the PK read cursor. Do not maintain a redundant per-ID index
-- on the primary rights database: each extra B-tree creates write contention.
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS catalog_index_source_ai
AFTER INSERT ON gutenberg_source_cache BEGIN
 INSERT INTO catalog_index_changefeed(cache_id,operation) VALUES(new.id,'upsert');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS catalog_index_source_au
AFTER UPDATE OF title,summary,authors_json,subjects_json,bookshelves_json,languages_json,
 formats_json,rights_status,commercial_use_status,ingest_status,copyright
ON gutenberg_source_cache
WHEN old.title IS NOT new.title OR old.summary IS NOT new.summary
 OR old.authors_json IS NOT new.authors_json
 OR old.subjects_json IS NOT new.subjects_json
 OR old.bookshelves_json IS NOT new.bookshelves_json
 OR old.languages_json IS NOT new.languages_json
 OR old.formats_json IS NOT new.formats_json
 OR old.rights_status IS NOT new.rights_status
 OR old.commercial_use_status IS NOT new.commercial_use_status
 OR old.ingest_status IS NOT new.ingest_status
 OR old.copyright IS NOT new.copyright
BEGIN
 INSERT INTO catalog_index_changefeed(cache_id,operation) VALUES(new.id,'upsert');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS catalog_index_source_ad
AFTER DELETE ON gutenberg_source_cache BEGIN
 INSERT INTO catalog_index_changefeed(cache_id,operation) VALUES(old.id,'delete');
END;
