-- Do not rebuild or renumber FTS data. The existing trigger invariant makes
-- external_book_id a safe indexed locator, with product_id as the exact guard.
-- Fail the migration before replacing any trigger if existing data violates it.
CREATE TABLE _cove_fts_lookup_guard (ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO _cove_fts_lookup_guard(ok)
SELECT NOT EXISTS(SELECT 1 FROM catalog_search_fts f
 LEFT JOIN catalog_search_documents d ON d.product_id=f.product_id
 WHERE d.product_id IS NULL OR f.external_book_id IS NOT d.external_book_id);
INSERT INTO _cove_fts_lookup_guard(ok)
SELECT NOT EXISTS(SELECT 1 FROM catalog_search_fts_en f
 LEFT JOIN catalog_search_documents d ON d.product_id=f.product_id
 WHERE d.product_id IS NULL OR f.external_book_id IS NOT d.external_book_id);
DROP TABLE _cove_fts_lookup_guard;
--> statement-breakpoint
DROP TRIGGER `catalog_search_au`;
--> statement-breakpoint
CREATE TRIGGER `catalog_search_au` AFTER UPDATE ON `catalog_search_documents` BEGIN
  -- Indexed phrase narrows candidates; exact product identity remains mandatory.
  DELETE FROM catalog_search_fts WHERE rowid IN (
    SELECT rowid FROM catalog_search_fts
    WHERE external_book_id MATCH CASE WHEN old.external_book_id GLOB '*[A-Za-z0-9]*' AND instr(old.external_book_id,char(0))=0
      THEN '"'||replace(old.external_book_id,'"','""')||'"'
      ELSE '"coveftslookupfallback9e831"' END
      AND product_id=old.product_id
  );
  -- Unusual/non-token identifiers retain the original exact scan semantics.
  DELETE FROM catalog_search_fts WHERE product_id=old.product_id
    AND NOT (old.external_book_id GLOB '*[A-Za-z0-9]*' AND instr(old.external_book_id,char(0))=0);
  -- Indexed phrase narrows candidates; exact product identity remains mandatory.
  DELETE FROM catalog_search_fts_en WHERE rowid IN (
    SELECT rowid FROM catalog_search_fts_en
    WHERE external_book_id MATCH CASE WHEN old.external_book_id GLOB '*[A-Za-z0-9]*' AND instr(old.external_book_id,char(0))=0
      THEN '"'||replace(old.external_book_id,'"','""')||'"'
      ELSE '"coveftslookupfallback9e831"' END
      AND product_id=old.product_id
  );
  -- Unusual/non-token identifiers retain the original exact scan semantics.
  DELETE FROM catalog_search_fts_en WHERE product_id=old.product_id
    AND NOT (old.external_book_id GLOB '*[A-Za-z0-9]*' AND instr(old.external_book_id,char(0))=0);
  INSERT INTO catalog_search_fts(product_id,external_book_id,title,subtitle,contributors_text,series_text,publisher_text,isbn13,categories_text,keywords_text,description)
  SELECT new.product_id,new.external_book_id,new.title,new.subtitle,new.contributors_text,new.series_text,new.publisher_text,new.isbn13,new.categories_text,new.keywords_text,new.description WHERE new.suppressed=0;
  INSERT INTO catalog_search_fts_en(product_id,external_book_id,title,subtitle,contributors_text,series_text,publisher_text,isbn13,categories_text,keywords_text,description)
  SELECT new.product_id,new.external_book_id,new.title,new.subtitle,new.contributors_text,new.series_text,new.publisher_text,new.isbn13,new.categories_text,new.keywords_text,new.description
  WHERE new.suppressed=0 AND EXISTS(SELECT 1 FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=new.product_id AND lower(e.language)='en');
  INSERT INTO search_index_outbox(product_id,operation,queued_at,attempts,last_error) VALUES(new.product_id,'upsert',datetime('now'),0,'')
  ON CONFLICT(product_id) DO UPDATE SET operation='upsert',queued_at=excluded.queued_at,attempts=0,last_error='';
END;
--> statement-breakpoint
DROP TRIGGER `catalog_search_ad`;
--> statement-breakpoint
CREATE TRIGGER `catalog_search_ad` AFTER DELETE ON `catalog_search_documents` BEGIN
  -- Indexed phrase narrows candidates; exact product identity remains mandatory.
  DELETE FROM catalog_search_fts WHERE rowid IN (
    SELECT rowid FROM catalog_search_fts
    WHERE external_book_id MATCH CASE WHEN old.external_book_id GLOB '*[A-Za-z0-9]*' AND instr(old.external_book_id,char(0))=0
      THEN '"'||replace(old.external_book_id,'"','""')||'"'
      ELSE '"coveftslookupfallback9e831"' END
      AND product_id=old.product_id
  );
  -- Unusual/non-token identifiers retain the original exact scan semantics.
  DELETE FROM catalog_search_fts WHERE product_id=old.product_id
    AND NOT (old.external_book_id GLOB '*[A-Za-z0-9]*' AND instr(old.external_book_id,char(0))=0);
  -- Indexed phrase narrows candidates; exact product identity remains mandatory.
  DELETE FROM catalog_search_fts_en WHERE rowid IN (
    SELECT rowid FROM catalog_search_fts_en
    WHERE external_book_id MATCH CASE WHEN old.external_book_id GLOB '*[A-Za-z0-9]*' AND instr(old.external_book_id,char(0))=0
      THEN '"'||replace(old.external_book_id,'"','""')||'"'
      ELSE '"coveftslookupfallback9e831"' END
      AND product_id=old.product_id
  );
  -- Unusual/non-token identifiers retain the original exact scan semantics.
  DELETE FROM catalog_search_fts_en WHERE product_id=old.product_id
    AND NOT (old.external_book_id GLOB '*[A-Za-z0-9]*' AND instr(old.external_book_id,char(0))=0);
  INSERT INTO search_index_outbox(product_id,operation,queued_at,attempts,last_error) VALUES(old.product_id,'delete',datetime('now'),0,'')
  ON CONFLICT(product_id) DO UPDATE SET operation='delete',queued_at=excluded.queued_at,attempts=0,last_error='';
END;
