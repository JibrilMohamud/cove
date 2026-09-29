-- Commercial search infrastructure. The normalized catalog remains the source of truth;
-- this table is a denormalized projection optimized for search/index synchronization.
ALTER TABLE `catalog_search_documents` ADD COLUMN `publisher_text` text DEFAULT '' NOT NULL;
ALTER TABLE `catalog_search_documents` ADD COLUMN `imprint_text` text DEFAULT '' NOT NULL;
ALTER TABLE `catalog_search_documents` ADD COLUMN `series_text` text DEFAULT '' NOT NULL;
ALTER TABLE `catalog_search_documents` ADD COLUMN `isbn13` text DEFAULT '' NOT NULL;
ALTER TABLE `catalog_search_documents` ADD COLUMN `format` text DEFAULT 'ebook' NOT NULL;
ALTER TABLE `catalog_search_documents` ADD COLUMN `currency` text DEFAULT 'USD' NOT NULL;
ALTER TABLE `catalog_search_documents` ADD COLUMN `price_minor` integer DEFAULT 0 NOT NULL;
ALTER TABLE `catalog_search_documents` ADD COLUMN `subscription_eligible` integer DEFAULT 0 NOT NULL;
ALTER TABLE `catalog_search_documents` ADD COLUMN `library_eligible` integer DEFAULT 0 NOT NULL;
ALTER TABLE `catalog_search_documents` ADD COLUMN `average_rating` real DEFAULT 0 NOT NULL;
ALTER TABLE `catalog_search_documents` ADD COLUMN `review_count` integer DEFAULT 0 NOT NULL;
ALTER TABLE `catalog_search_documents` ADD COLUMN `sales_velocity` real DEFAULT 0 NOT NULL;
ALTER TABLE `catalog_search_documents` ADD COLUMN `merchandising_boost` real DEFAULT 0 NOT NULL;
ALTER TABLE `catalog_search_documents` ADD COLUMN `availability` text DEFAULT 'available' NOT NULL;
ALTER TABLE `catalog_search_documents` ADD COLUMN `is_deal` integer DEFAULT 0 NOT NULL;
ALTER TABLE `catalog_search_documents` ADD COLUMN `suppressed` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_search_price` ON `catalog_search_documents` (`currency`,`price_minor`);
CREATE INDEX `idx_search_rating` ON `catalog_search_documents` (`average_rating`,`review_count`);
CREATE INDEX `idx_search_release` ON `catalog_search_documents` (`release_date`);
--> statement-breakpoint
UPDATE catalog_search_documents
SET publisher_text=COALESCE((SELECT pub.name FROM products p JOIN editions e ON e.id=p.edition_id LEFT JOIN publishers pub ON pub.id=e.publisher_id WHERE p.id=catalog_search_documents.product_id),''),
    imprint_text=COALESCE((SELECT imp.name FROM products p JOIN editions e ON e.id=p.edition_id LEFT JOIN imprints imp ON imp.id=e.imprint_id WHERE p.id=catalog_search_documents.product_id),''),
    series_text=COALESCE((SELECT group_concat(s.name,' | ') FROM products p JOIN editions e ON e.id=p.edition_id JOIN series_memberships sm ON sm.edition_id=e.id JOIN series s ON s.id=sm.series_id WHERE p.id=catalog_search_documents.product_id),''),
    isbn13=COALESCE((SELECT e.isbn13 FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=catalog_search_documents.product_id),''),
    format=COALESCE((SELECT p.format FROM products p WHERE p.id=catalog_search_documents.product_id),'ebook'),
    currency=COALESCE((SELECT o.currency FROM offers o WHERE o.product_id=catalog_search_documents.product_id AND o.active=1 ORDER BY o.created_at DESC LIMIT 1),'USD'),
    price_minor=COALESCE((SELECT o.amount_minor FROM offers o WHERE o.product_id=catalog_search_documents.product_id AND o.active=1 ORDER BY o.created_at DESC LIMIT 1),0),
    subscription_eligible=COALESCE((SELECT e.subscription_eligible FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=catalog_search_documents.product_id),0),
    library_eligible=COALESCE((SELECT e.library_eligible FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=catalog_search_documents.product_id),0),
    release_date=(SELECT e.release_date FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=catalog_search_documents.product_id),
    availability=CASE WHEN EXISTS(SELECT 1 FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=catalog_search_documents.product_id AND p.storefront_status='active' AND e.release_status IN ('available','preorder')) THEN 'available' ELSE 'unavailable' END,
    average_rating=COALESCE((SELECT AVG(r.rating_steps)/2.0 FROM reviews r WHERE r.book_id=catalog_search_documents.external_book_id AND r.visibility='public' AND r.moderation='visible' AND r.rating_steps IS NOT NULL),0),
    review_count=COALESCE((SELECT COUNT(*) FROM reviews r WHERE r.book_id=catalog_search_documents.external_book_id AND r.visibility='public' AND r.moderation='visible' AND r.rating_steps IS NOT NULL),0),
    is_deal=CASE WHEN EXISTS(SELECT 1 FROM offers o JOIN promotions pr ON pr.offer_id=o.id WHERE o.product_id=catalog_search_documents.product_id AND o.active=1 AND pr.active=1 AND pr.starts_at<=datetime('now') AND pr.ends_at>datetime('now')) THEN 1 ELSE 0 END;
-- Never send private sideload metadata to an external search service.
UPDATE catalog_search_documents SET suppressed=1,availability='private' WHERE product_id IN (SELECT id FROM products WHERE source_name='upload');
--> statement-breakpoint
-- D1 supports FTS5. Keep two indexes: Unicode for all languages and Porter stemming for English-filtered searches.
CREATE VIRTUAL TABLE `catalog_search_fts` USING fts5(
  product_id UNINDEXED,
  external_book_id,
  title,
  subtitle,
  contributors_text,
  series_text,
  publisher_text,
  isbn13,
  categories_text,
  keywords_text,
  description,
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3 4'
);
--> statement-breakpoint
CREATE VIRTUAL TABLE `catalog_search_fts_en` USING fts5(
  product_id UNINDEXED,
  external_book_id,
  title,
  subtitle,
  contributors_text,
  series_text,
  publisher_text,
  isbn13,
  categories_text,
  keywords_text,
  description,
  tokenize='porter unicode61 remove_diacritics 2',
  prefix='2 3 4'
);
--> statement-breakpoint
CREATE VIRTUAL TABLE `catalog_search_vocab` USING fts5vocab(`catalog_search_fts`, 'row');
--> statement-breakpoint
INSERT INTO catalog_search_fts(product_id,external_book_id,title,subtitle,contributors_text,series_text,publisher_text,isbn13,categories_text,keywords_text,description)
SELECT product_id,external_book_id,title,subtitle,contributors_text,series_text,publisher_text,isbn13,categories_text,keywords_text,description FROM catalog_search_documents WHERE suppressed=0;
INSERT INTO catalog_search_fts_en(product_id,external_book_id,title,subtitle,contributors_text,series_text,publisher_text,isbn13,categories_text,keywords_text,description)
SELECT d.product_id,d.external_book_id,d.title,d.subtitle,d.contributors_text,d.series_text,d.publisher_text,d.isbn13,d.categories_text,d.keywords_text,d.description
FROM catalog_search_documents d JOIN products p ON p.id=d.product_id JOIN editions e ON e.id=p.edition_id
WHERE d.suppressed=0 AND lower(e.language)='en';
--> statement-breakpoint
CREATE TABLE `search_index_outbox` (
  `product_id` text PRIMARY KEY NOT NULL,
  `operation` text DEFAULT 'upsert' NOT NULL,
  `queued_at` text NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `last_error` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `search_index_state` (
  `id` integer PRIMARY KEY NOT NULL,
  `backend` text DEFAULT 'd1' NOT NULL,
  `index_uid` text DEFAULT 'fore_books' NOT NULL,
  `settings_version` integer DEFAULT 0 NOT NULL,
  `last_synced_at` text,
  `last_error` text DEFAULT '' NOT NULL,
  `documents_indexed` integer DEFAULT 0 NOT NULL
);
INSERT OR IGNORE INTO search_index_state(id) VALUES(1);
--> statement-breakpoint
CREATE TABLE `search_synonyms` (
  `term` text PRIMARY KEY NOT NULL,
  `synonyms_json` text NOT NULL,
  `enabled` integer DEFAULT 1 NOT NULL,
  `updated_at` text NOT NULL
);
INSERT OR IGNORE INTO search_synonyms(term,synonyms_json,enabled,updated_at) VALUES
  ('ebook','["e-book"]',1,datetime('now')),
  ('e-book','["ebook"]',1,datetime('now')),
  ('audiobook','["audio book"]',1,datetime('now')),
  ('sci-fi','["science fiction","science-fiction"]',1,datetime('now')),
  ('science fiction','["sci-fi","science-fiction"]',1,datetime('now')),
  ('ya','["young adult"]',1,datetime('now'));
--> statement-breakpoint
CREATE TABLE `search_query_events` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text,
  `query` text DEFAULT '' NOT NULL,
  `normalized_query` text DEFAULT '' NOT NULL,
  `filters_json` text DEFAULT '{}' NOT NULL,
  `sort` text DEFAULT 'relevance' NOT NULL,
  `result_count` integer DEFAULT 0 NOT NULL,
  `backend` text NOT NULL,
  `duration_ms` integer DEFAULT 0 NOT NULL,
  `corrected_query` text,
  `result_impressions_json` text DEFAULT '[]' NOT NULL,
  `created_at` text NOT NULL
);
CREATE INDEX `idx_search_events_recent` ON `search_query_events` (`created_at`);
CREATE INDEX `idx_search_events_query` ON `search_query_events` (`normalized_query`,`created_at`);
--> statement-breakpoint
CREATE TABLE `search_click_events` (
  `query_id` text NOT NULL,
  `product_id` text NOT NULL,
  `position` integer NOT NULL,
  `created_at` text NOT NULL,
  PRIMARY KEY(`query_id`,`product_id`,`position`),
  FOREIGN KEY (`query_id`) REFERENCES `search_query_events`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `idx_search_clicks_product` ON `search_click_events` (`product_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `search_merchandising_rules` (
  `id` text PRIMARY KEY NOT NULL,
  `product_id` text NOT NULL,
  `boost` real DEFAULT 0 NOT NULL,
  `starts_at` text,
  `ends_at` text,
  `active` integer DEFAULT 1 NOT NULL,
  `reason` text DEFAULT '' NOT NULL,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `idx_search_merchandising_active` ON `search_merchandising_rules` (`active`,`starts_at`,`ends_at`);
--> statement-breakpoint
-- Keep both FTS indexes and the external search outbox synchronized with the denormalized projection.
CREATE TRIGGER `catalog_search_ai` AFTER INSERT ON `catalog_search_documents` BEGIN
  INSERT INTO catalog_search_fts(product_id,external_book_id,title,subtitle,contributors_text,series_text,publisher_text,isbn13,categories_text,keywords_text,description)
  SELECT new.product_id,new.external_book_id,new.title,new.subtitle,new.contributors_text,new.series_text,new.publisher_text,new.isbn13,new.categories_text,new.keywords_text,new.description WHERE new.suppressed=0;
  INSERT INTO catalog_search_fts_en(product_id,external_book_id,title,subtitle,contributors_text,series_text,publisher_text,isbn13,categories_text,keywords_text,description)
  SELECT new.product_id,new.external_book_id,new.title,new.subtitle,new.contributors_text,new.series_text,new.publisher_text,new.isbn13,new.categories_text,new.keywords_text,new.description
  WHERE new.suppressed=0 AND EXISTS(SELECT 1 FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=new.product_id AND lower(e.language)='en');
  INSERT INTO search_index_outbox(product_id,operation,queued_at,attempts,last_error) VALUES(new.product_id,'upsert',datetime('now'),0,'')
  ON CONFLICT(product_id) DO UPDATE SET operation='upsert',queued_at=excluded.queued_at,attempts=0,last_error='';
END;
--> statement-breakpoint
CREATE TRIGGER `catalog_search_au` AFTER UPDATE ON `catalog_search_documents` BEGIN
  DELETE FROM catalog_search_fts WHERE product_id=old.product_id;
  DELETE FROM catalog_search_fts_en WHERE product_id=old.product_id;
  INSERT INTO catalog_search_fts(product_id,external_book_id,title,subtitle,contributors_text,series_text,publisher_text,isbn13,categories_text,keywords_text,description)
  SELECT new.product_id,new.external_book_id,new.title,new.subtitle,new.contributors_text,new.series_text,new.publisher_text,new.isbn13,new.categories_text,new.keywords_text,new.description WHERE new.suppressed=0;
  INSERT INTO catalog_search_fts_en(product_id,external_book_id,title,subtitle,contributors_text,series_text,publisher_text,isbn13,categories_text,keywords_text,description)
  SELECT new.product_id,new.external_book_id,new.title,new.subtitle,new.contributors_text,new.series_text,new.publisher_text,new.isbn13,new.categories_text,new.keywords_text,new.description
  WHERE new.suppressed=0 AND EXISTS(SELECT 1 FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=new.product_id AND lower(e.language)='en');
  INSERT INTO search_index_outbox(product_id,operation,queued_at,attempts,last_error) VALUES(new.product_id,'upsert',datetime('now'),0,'')
  ON CONFLICT(product_id) DO UPDATE SET operation='upsert',queued_at=excluded.queued_at,attempts=0,last_error='';
END;
--> statement-breakpoint
CREATE TRIGGER `catalog_search_ad` AFTER DELETE ON `catalog_search_documents` BEGIN
  DELETE FROM catalog_search_fts WHERE product_id=old.product_id;
  DELETE FROM catalog_search_fts_en WHERE product_id=old.product_id;
  INSERT INTO search_index_outbox(product_id,operation,queued_at,attempts,last_error) VALUES(old.product_id,'delete',datetime('now'),0,'')
  ON CONFLICT(product_id) DO UPDATE SET operation='delete',queued_at=excluded.queued_at,attempts=0,last_error='';
END;
--> statement-breakpoint
-- Seed the external index queue for all pre-existing products.
INSERT OR IGNORE INTO search_index_outbox(product_id,operation,queued_at) SELECT product_id,'upsert',datetime('now') FROM catalog_search_documents;
