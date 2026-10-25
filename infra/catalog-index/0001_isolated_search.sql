-- Apply ONLY to a newly provisioned, independent catalog index D1.
-- Intentionally lacks rights_grants, orders, customers and entitlements.
CREATE TABLE IF NOT EXISTS catalog_index_identity (
 id INTEGER PRIMARY KEY CHECK(id=1),
 domain TEXT NOT NULL CHECK(domain='cove-independent-catalog-index')
);
INSERT OR IGNORE INTO catalog_index_identity(id,domain)
 VALUES(1,'cove-independent-catalog-index');
CREATE TABLE IF NOT EXISTS catalog_index_capture (
 id INTEGER PRIMARY KEY CHECK(id=1),
 owner TEXT NOT NULL DEFAULT '',
 lease_until INTEGER NOT NULL DEFAULT 0,
 backfill_cursor TEXT NOT NULL DEFAULT '',
 backfill_done INTEGER NOT NULL DEFAULT 0 CHECK(backfill_done IN (0,1)),
 feed_cursor INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO catalog_index_capture(id) VALUES(1);
CREATE TABLE IF NOT EXISTS catalog_index_documents (
 product_id TEXT PRIMARY KEY NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>=0),
 visible INTEGER NOT NULL CHECK(visible IN (0,1)),
 title TEXT NOT NULL DEFAULT '',
 authors_text TEXT NOT NULL DEFAULT '',
 subjects_text TEXT NOT NULL DEFAULT '',
 shelves_text TEXT NOT NULL DEFAULT '',
 languages_text TEXT NOT NULL DEFAULT '',
 description TEXT NOT NULL DEFAULT '',
 source_updated_at TEXT NOT NULL DEFAULT ''
);
CREATE VIRTUAL TABLE IF NOT EXISTS catalog_index_fts USING fts5(
 product_id UNINDEXED,title,authors_text,subjects_text,shelves_text,
 description,tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS catalog_index_docs_ai
AFTER INSERT ON catalog_index_documents BEGIN
 INSERT INTO catalog_index_fts(product_id,title,authors_text,subjects_text,shelves_text,description)
 SELECT new.product_id,new.title,new.authors_text,new.subjects_text,new.shelves_text,new.description
 WHERE new.visible=1;
END;
CREATE TRIGGER IF NOT EXISTS catalog_index_docs_au
AFTER UPDATE ON catalog_index_documents BEGIN
 DELETE FROM catalog_index_fts WHERE product_id=old.product_id;
 INSERT INTO catalog_index_fts(product_id,title,authors_text,subjects_text,shelves_text,description)
 SELECT new.product_id,new.title,new.authors_text,new.subjects_text,new.shelves_text,new.description
 WHERE new.visible=1;
END;
CREATE TRIGGER IF NOT EXISTS catalog_index_docs_ad
AFTER DELETE ON catalog_index_documents BEGIN
 DELETE FROM catalog_index_fts WHERE product_id=old.product_id;
END;
