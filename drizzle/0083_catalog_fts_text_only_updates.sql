-- FTS terms depend on TEXT, visibility and locale, not on popularity,
-- price, timestamps or operational counts. Rebuilding both FTS tables for
-- a download_count-only update amplified writes on the primary D1 and
-- unnecessarily serialized customer-facing rights reads.
--
-- Reuse the exact indexed-delete guard from migration 0075. Do not scan or
-- recreate the existing FTS data; only change the trigger conditions.
-- Separate external-index queue freshness from FTS token maintenance.
--
-- Keep the old DELETE and INSERT triggers (which enforce revocation/
-- publication). FTS update trigger now runs only for actually changed
-- indexed text, language membership or suppression.
DROP TRIGGER `catalog_search_au`;
--> statement-breakpoint
CREATE TRIGGER `catalog_search_au` AFTER UPDATE ON `catalog_search_documents`
WHEN old.product_id IS NOT new.product_id OR
  old.external_book_id IS NOT new.external_book_id OR
  old.title IS NOT new.title OR
  old.subtitle IS NOT new.subtitle OR
  old.contributors_text IS NOT new.contributors_text OR
  old.series_text IS NOT new.series_text OR
  old.publisher_text IS NOT new.publisher_text OR
  old.isbn13 IS NOT new.isbn13 OR
  old.categories_text IS NOT new.categories_text OR
  old.keywords_text IS NOT new.keywords_text OR
  old.description IS NOT new.description OR
  old.languages_text IS NOT new.languages_text OR
  old.suppressed IS NOT new.suppressed
BEGIN
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
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `catalog_search_au_outbox`;
--> statement-breakpoint
CREATE TRIGGER `catalog_search_au_outbox` AFTER UPDATE ON `catalog_search_documents` BEGIN
  -- External index needs freshness for every update, including popularity;
  -- but a non-rights popularity heartbeat cannot reverse a legal tombstone.
  INSERT INTO search_index_outbox(product_id,operation,queued_at,attempts,last_error)
  VALUES(new.product_id,'upsert',datetime('now'),0,'')
  ON CONFLICT(product_id) DO UPDATE SET operation='upsert',
    queued_at=excluded.queued_at,attempts=0,last_error=''
  WHERE search_index_outbox.operation<>'delete'
    OR (old.suppressed=1 AND new.suppressed=0 AND new.availability='available');
END;
