CREATE TABLE `publishers` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `website` text DEFAULT '' NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
CREATE UNIQUE INDEX `idx_publishers_name` ON `publishers` (`name`);

CREATE TABLE `imprints` (
  `id` text PRIMARY KEY NOT NULL,
  `publisher_id` text NOT NULL,
  `name` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`publisher_id`) REFERENCES `publishers`(`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `idx_imprints_publisher_name` ON `imprints` (`publisher_id`,`name`);

CREATE TABLE `works` (
  `id` text PRIMARY KEY NOT NULL,
  `title` text NOT NULL,
  `subtitle` text DEFAULT '' NOT NULL,
  `description` text DEFAULT '' NOT NULL,
  `original_publication_date` text,
  `original_language` text,
  `min_age` integer,
  `max_age` integer,
  `content_warnings` text DEFAULT '' NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
CREATE INDEX `idx_works_title` ON `works` (`title`);

CREATE TABLE `contributors` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `sort_name` text DEFAULT '' NOT NULL,
  `bio` text DEFAULT '' NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
CREATE INDEX `idx_contributors_name` ON `contributors` (`name`);

CREATE TABLE `editions` (
  `id` text PRIMARY KEY NOT NULL,
  `work_id` text NOT NULL,
  `publisher_id` text,
  `imprint_id` text,
  `title` text NOT NULL,
  `subtitle` text DEFAULT '' NOT NULL,
  `description` text DEFAULT '' NOT NULL,
  `edition_number` text DEFAULT '' NOT NULL,
  `language` text DEFAULT 'en' NOT NULL,
  `original_language` text,
  `publication_date` text,
  `release_date` text,
  `preorder_date` text,
  `isbn13` text,
  `publisher_identifier` text,
  `page_estimate` integer,
  `word_count` integer,
  `reading_time_minutes` integer,
  `file_size_bytes` integer,
  `epub_version` text,
  `layout` text DEFAULT 'reflowable' NOT NULL,
  `drm_status` text DEFAULT 'none' NOT NULL,
  `downloadable` integer DEFAULT 1 NOT NULL,
  `release_status` text DEFAULT 'available' NOT NULL,
  `subscription_eligible` integer DEFAULT 0 NOT NULL,
  `library_eligible` integer DEFAULT 0 NOT NULL,
  `publisher_description` text DEFAULT '' NOT NULL,
  `editorial_reviews` text DEFAULT '' NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`publisher_id`) REFERENCES `publishers`(`id`) ON DELETE SET NULL,
  FOREIGN KEY (`imprint_id`) REFERENCES `imprints`(`id`) ON DELETE SET NULL
);
CREATE INDEX `idx_editions_work` ON `editions` (`work_id`);
CREATE INDEX `idx_editions_isbn13` ON `editions` (`isbn13`);
CREATE INDEX `idx_editions_release` ON `editions` (`release_date`);

CREATE TABLE `edition_contributors` (
  `edition_id` text NOT NULL,
  `contributor_id` text NOT NULL,
  `role` text NOT NULL,
  `position` integer DEFAULT 0 NOT NULL,
  PRIMARY KEY (`edition_id`,`contributor_id`,`role`),
  FOREIGN KEY (`edition_id`) REFERENCES `editions`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`contributor_id`) REFERENCES `contributors`(`id`) ON DELETE CASCADE
);
CREATE INDEX `idx_edition_contributors_person` ON `edition_contributors` (`contributor_id`,`role`);

CREATE TABLE `series` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `description` text DEFAULT '' NOT NULL,
  `publisher_id` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`publisher_id`) REFERENCES `publishers`(`id`) ON DELETE SET NULL
);
CREATE INDEX `idx_series_name` ON `series` (`name`);

CREATE TABLE `series_memberships` (
  `series_id` text NOT NULL,
  `edition_id` text NOT NULL,
  `position` real,
  `label` text DEFAULT '' NOT NULL,
  PRIMARY KEY (`series_id`,`edition_id`),
  FOREIGN KEY (`series_id`) REFERENCES `series`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`edition_id`) REFERENCES `editions`(`id`) ON DELETE CASCADE
);

CREATE TABLE `categories` (
  `id` text PRIMARY KEY NOT NULL,
  `scheme` text NOT NULL,
  `code` text DEFAULT '' NOT NULL,
  `name` text NOT NULL,
  `parent_id` text,
  FOREIGN KEY (`parent_id`) REFERENCES `categories`(`id`) ON DELETE SET NULL
);
CREATE UNIQUE INDEX `idx_categories_scheme_name` ON `categories` (`scheme`,`name`);

CREATE TABLE `edition_categories` (
  `edition_id` text NOT NULL,
  `category_id` text NOT NULL,
  `position` integer DEFAULT 0 NOT NULL,
  PRIMARY KEY (`edition_id`,`category_id`),
  FOREIGN KEY (`edition_id`) REFERENCES `editions`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON DELETE CASCADE
);
CREATE INDEX `idx_edition_categories_category` ON `edition_categories` (`category_id`);

CREATE TABLE `edition_languages` (
  `edition_id` text NOT NULL,
  `language_code` text NOT NULL,
  `kind` text DEFAULT 'content' NOT NULL,
  PRIMARY KEY (`edition_id`,`language_code`,`kind`),
  FOREIGN KEY (`edition_id`) REFERENCES `editions`(`id`) ON DELETE CASCADE
);
CREATE INDEX `idx_edition_languages_language` ON `edition_languages` (`language_code`);

CREATE TABLE `keywords` (
  `id` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL
);
CREATE UNIQUE INDEX `idx_keywords_value` ON `keywords` (`value`);

CREATE TABLE `edition_keywords` (
  `edition_id` text NOT NULL,
  `keyword_id` text NOT NULL,
  PRIMARY KEY (`edition_id`,`keyword_id`),
  FOREIGN KEY (`edition_id`) REFERENCES `editions`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`keyword_id`) REFERENCES `keywords`(`id`) ON DELETE CASCADE
);

CREATE TABLE `products` (
  `id` text PRIMARY KEY NOT NULL,
  `edition_id` text NOT NULL,
  `sku` text NOT NULL,
  `format` text NOT NULL,
  `storefront_status` text DEFAULT 'active' NOT NULL,
  `source_name` text NOT NULL,
  `source_external_id` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`edition_id`) REFERENCES `editions`(`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `idx_products_sku` ON `products` (`sku`);
CREATE UNIQUE INDEX `idx_products_source` ON `products` (`source_name`,`source_external_id`);
CREATE INDEX `idx_products_edition` ON `products` (`edition_id`);

CREATE TABLE `external_identifiers` (
  `entity_type` text NOT NULL,
  `entity_id` text NOT NULL,
  `scheme` text NOT NULL,
  `value` text NOT NULL,
  PRIMARY KEY (`entity_type`,`entity_id`,`scheme`)
);
CREATE UNIQUE INDEX `idx_external_identifiers_lookup` ON `external_identifiers` (`scheme`,`value`,`entity_type`);

CREATE TABLE `territories` (
  `code` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL
);

CREATE TABLE `rights_grants` (
  `id` text PRIMARY KEY NOT NULL,
  `edition_id` text NOT NULL,
  `rightsholder_id` text,
  `territory_code` text NOT NULL,
  `format` text NOT NULL,
  `sales_channel` text DEFAULT 'retail' NOT NULL,
  `starts_at` text,
  `ends_at` text,
  `license_type` text NOT NULL,
  `drm_requirement` text DEFAULT 'none' NOT NULL,
  `subscription_permitted` integer DEFAULT 0 NOT NULL,
  `library_permitted` integer DEFAULT 0 NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`edition_id`) REFERENCES `editions`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`rightsholder_id`) REFERENCES `publishers`(`id`) ON DELETE SET NULL,
  FOREIGN KEY (`territory_code`) REFERENCES `territories`(`code`) ON DELETE CASCADE
);
CREATE INDEX `idx_rights_edition_territory` ON `rights_grants` (`edition_id`,`territory_code`,`format`);

CREATE TABLE `offers` (
  `id` text PRIMARY KEY NOT NULL,
  `product_id` text NOT NULL,
  `offer_type` text NOT NULL,
  `currency` text NOT NULL,
  `amount_minor` integer NOT NULL,
  `active` integer DEFAULT 1 NOT NULL,
  `starts_at` text,
  `ends_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE
);
CREATE INDEX `idx_offers_product_active` ON `offers` (`product_id`,`active`,`starts_at`,`ends_at`);

CREATE TABLE `price_schedules` (
  `id` text PRIMARY KEY NOT NULL,
  `offer_id` text NOT NULL,
  `currency` text NOT NULL,
  `amount_minor` integer NOT NULL,
  `starts_at` text NOT NULL,
  `ends_at` text,
  FOREIGN KEY (`offer_id`) REFERENCES `offers`(`id`) ON DELETE CASCADE
);
CREATE INDEX `idx_price_schedules_offer` ON `price_schedules` (`offer_id`,`starts_at`);

CREATE TABLE `promotions` (
  `id` text PRIMARY KEY NOT NULL,
  `offer_id` text NOT NULL,
  `name` text NOT NULL,
  `promotion_type` text NOT NULL,
  `amount_minor` integer,
  `starts_at` text NOT NULL,
  `ends_at` text NOT NULL,
  `active` integer DEFAULT 1 NOT NULL,
  FOREIGN KEY (`offer_id`) REFERENCES `offers`(`id`) ON DELETE CASCADE
);

CREATE TABLE `digital_assets` (
  `id` text PRIMARY KEY NOT NULL,
  `edition_id` text NOT NULL,
  `kind` text NOT NULL,
  `current_version_id` text,
  `drm_status` text DEFAULT 'none' NOT NULL,
  `downloadable` integer DEFAULT 1 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`edition_id`) REFERENCES `editions`(`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `idx_digital_assets_edition_kind` ON `digital_assets` (`edition_id`,`kind`);

CREATE TABLE `asset_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `asset_id` text NOT NULL,
  `version_number` integer NOT NULL,
  `object_key` text,
  `source_url` text,
  `mime_type` text NOT NULL,
  `size_bytes` integer,
  `sha256` text,
  `epub_version` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`asset_id`) REFERENCES `digital_assets`(`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `idx_asset_versions_number` ON `asset_versions` (`asset_id`,`version_number`);

CREATE TABLE `accessibility_metadata` (
  `edition_id` text PRIMARY KEY NOT NULL,
  `screen_reader_compatible` integer,
  `alt_text_complete` integer,
  `semantic_structure` integer,
  `accessibility_summary` text DEFAULT '' NOT NULL,
  `certifier` text DEFAULT '' NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`edition_id`) REFERENCES `editions`(`id`) ON DELETE CASCADE
);

CREATE TABLE `catalog_search_documents` (
  `product_id` text PRIMARY KEY NOT NULL,
  `external_book_id` text NOT NULL,
  `title` text NOT NULL,
  `subtitle` text DEFAULT '' NOT NULL,
  `contributors_text` text DEFAULT '' NOT NULL,
  `subjects_text` text DEFAULT '' NOT NULL,
  `bookshelves_text` text DEFAULT '' NOT NULL,
  `categories_text` text DEFAULT '' NOT NULL,
  `languages_text` text DEFAULT '' NOT NULL,
  `keywords_text` text DEFAULT '' NOT NULL,
  `description` text DEFAULT '' NOT NULL,
  `download_count` integer DEFAULT 0 NOT NULL,
  `release_date` text,
  `first_ingested_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `idx_search_external_book` ON `catalog_search_documents` (`external_book_id`);
CREATE INDEX `idx_search_popular` ON `catalog_search_documents` (`download_count`);
CREATE INDEX `idx_search_added` ON `catalog_search_documents` (`first_ingested_at`);

CREATE TABLE `entitlements` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `product_id` text NOT NULL,
  `entitlement_type` text NOT NULL,
  `status` text DEFAULT 'active' NOT NULL,
  `source` text NOT NULL,
  `order_item_id` text,
  `starts_at` text,
  `ends_at` text,
  `granted_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `idx_entitlements_user_product_type` ON `entitlements` (`user_id`,`product_id`,`entitlement_type`);
CREATE INDEX `idx_entitlements_active` ON `entitlements` (`user_id`,`status`,`ends_at`);

CREATE TABLE `reading_states` (
  `user_id` text NOT NULL,
  `product_id` text NOT NULL,
  `external_book_id` text NOT NULL,
  `in_library` integer DEFAULT 1 NOT NULL,
  `status` text DEFAULT 'want-to-read' NOT NULL,
  `progress` real DEFAULT 0 NOT NULL,
  `cfi` text DEFAULT '' NOT NULL,
  `legacy_shelves_json` text DEFAULT '[]' NOT NULL,
  `legacy_rating` real,
  `legacy_review` text DEFAULT '' NOT NULL,
  `review_migrated` integer DEFAULT 0 NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`user_id`,`product_id`),
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE
);
CREATE INDEX `idx_reading_states_library` ON `reading_states` (`user_id`,`in_library`,`updated_at`);

CREATE TABLE `personal_imports` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `product_id` text NOT NULL,
  `object_key` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE
);
CREATE INDEX `idx_personal_imports_user` ON `personal_imports` (`user_id`);

CREATE TABLE `shelf_items` (
  `shelf_id` text NOT NULL,
  `product_id` text NOT NULL,
  `external_book_id` text NOT NULL,
  `position` integer DEFAULT 0 NOT NULL,
  `note` text DEFAULT '' NOT NULL,
  `added_at` text NOT NULL,
  PRIMARY KEY (`shelf_id`,`product_id`),
  FOREIGN KEY (`shelf_id`) REFERENCES `shelves`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE
);
CREATE INDEX `idx_shelf_items_order` ON `shelf_items` (`shelf_id`,`position`);

CREATE TABLE `completion_events` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `product_id` text NOT NULL,
  `external_book_id` text NOT NULL,
  `finished_at` text NOT NULL,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE
);
CREATE INDEX `idx_completion_events_user_date` ON `completion_events` (`user_id`,`finished_at`);

INSERT OR IGNORE INTO `publishers` (`id`,`name`,`website`,`created_at`,`updated_at`)
VALUES ('pub_project_gutenberg','Project Gutenberg','https://www.gutenberg.org/','1971-07-04T00:00:00.000Z','1971-07-04T00:00:00.000Z');
INSERT OR IGNORE INTO `territories` (`code`,`name`) VALUES ('US','United States');

-- Convert the existing Gutenberg cache into canonical works/editions/products.
INSERT OR IGNORE INTO `works` (`id`,`title`,`description`,`created_at`,`updated_at`)
SELECT 'wrk_gutenberg_'||id,title,summary,first_ingested_at,updated_at FROM catalog_books;
INSERT OR IGNORE INTO `editions` (`id`,`work_id`,`publisher_id`,`title`,`description`,`language`,`drm_status`,`downloadable`,`release_status`,`created_at`,`updated_at`)
SELECT 'ed_gutenberg_'||id,'wrk_gutenberg_'||id,'pub_project_gutenberg',title,summary,COALESCE(json_extract(languages_json,'$[0]'),'en'),'none',1,'available',first_ingested_at,updated_at FROM catalog_books;
INSERT OR IGNORE INTO `products` (`id`,`edition_id`,`sku`,`format`,`storefront_status`,`source_name`,`source_external_id`,`created_at`,`updated_at`)
SELECT 'prd_gutenberg_'||id,'ed_gutenberg_'||id,'GUTENBERG-'||id,'ebook','active','gutenberg',id,first_ingested_at,updated_at FROM catalog_books;
INSERT OR IGNORE INTO `external_identifiers` (`entity_type`,`entity_id`,`scheme`,`value`)
SELECT 'product','prd_gutenberg_'||id,'gutenberg',id FROM catalog_books;
INSERT OR IGNORE INTO `offers` (`id`,`product_id`,`offer_type`,`currency`,`amount_minor`,`active`,`created_at`,`updated_at`)
SELECT 'off_gutenberg_'||id,'prd_gutenberg_'||id,'public-domain','USD',0,1,first_ingested_at,updated_at FROM catalog_books;
INSERT OR IGNORE INTO `rights_grants` (`id`,`edition_id`,`rightsholder_id`,`territory_code`,`format`,`sales_channel`,`license_type`,`drm_requirement`,`created_at`)
SELECT 'right_gutenberg_us_'||id,'ed_gutenberg_'||id,'pub_project_gutenberg','US','ebook','retail','public-domain','none',first_ingested_at FROM catalog_books WHERE copyright=0;

INSERT OR IGNORE INTO `contributors` (`id`,`name`,`sort_name`,`created_at`,`updated_at`)
SELECT DISTINCT 'con_name_'||hex(lower(json_extract(j.value,'$.name'))),json_extract(j.value,'$.name'),json_extract(j.value,'$.name'),c.first_ingested_at,c.updated_at
FROM catalog_books c, json_each(c.authors_json) j WHERE json_extract(j.value,'$.name') IS NOT NULL;
INSERT OR IGNORE INTO `edition_contributors` (`edition_id`,`contributor_id`,`role`,`position`)
SELECT 'ed_gutenberg_'||c.id,'con_name_'||hex(lower(json_extract(j.value,'$.name'))),'author',CAST(j.key AS INTEGER)
FROM catalog_books c, json_each(c.authors_json) j WHERE json_extract(j.value,'$.name') IS NOT NULL;

INSERT OR IGNORE INTO `categories` (`id`,`scheme`,`name`)
SELECT DISTINCT 'cat_subject_'||hex(lower(j.value)),'gutenberg-subject',j.value FROM catalog_books c, json_each(c.subjects_json) j;
INSERT OR IGNORE INTO `edition_categories` (`edition_id`,`category_id`,`position`)
SELECT 'ed_gutenberg_'||c.id,'cat_subject_'||hex(lower(j.value)),CAST(j.key AS INTEGER) FROM catalog_books c, json_each(c.subjects_json) j;
INSERT OR IGNORE INTO `categories` (`id`,`scheme`,`name`)
SELECT DISTINCT 'cat_shelf_'||hex(lower(j.value)),'gutenberg-bookshelf',j.value FROM catalog_books c, json_each(c.bookshelves_json) j;
INSERT OR IGNORE INTO `edition_categories` (`edition_id`,`category_id`,`position`)
SELECT 'ed_gutenberg_'||c.id,'cat_shelf_'||hex(lower(j.value)),1000+CAST(j.key AS INTEGER) FROM catalog_books c, json_each(c.bookshelves_json) j;
INSERT OR IGNORE INTO `edition_languages` (`edition_id`,`language_code`,`kind`)
SELECT 'ed_gutenberg_'||c.id,j.value,'content' FROM catalog_books c, json_each(c.languages_json) j;

INSERT OR IGNORE INTO `digital_assets` (`id`,`edition_id`,`kind`,`drm_status`,`downloadable`,`created_at`,`updated_at`)
SELECT 'asset_epub_gutenberg_'||id,'ed_gutenberg_'||id,'epub','none',1,first_ingested_at,updated_at FROM catalog_books;
INSERT OR IGNORE INTO `asset_versions` (`id`,`asset_id`,`version_number`,`source_url`,`mime_type`,`created_at`)
SELECT 'assetver_epub_gutenberg_'||id,'asset_epub_gutenberg_'||id,1,
COALESCE(json_extract(formats_json,'$."application/epub+zip"'),json_extract(formats_json,'$."application/epub+zip;"')),
'application/epub+zip',first_ingested_at FROM catalog_books;
UPDATE digital_assets SET current_version_id='assetver_epub_gutenberg_'||substr(id,length('asset_epub_gutenberg_')+1) WHERE id LIKE 'asset_epub_gutenberg_%';
INSERT OR IGNORE INTO `digital_assets` (`id`,`edition_id`,`kind`,`drm_status`,`downloadable`,`created_at`,`updated_at`)
SELECT 'asset_cover_gutenberg_'||id,'ed_gutenberg_'||id,'cover','none',1,first_ingested_at,updated_at FROM catalog_books
WHERE COALESCE(json_extract(formats_json,'$."image/jpeg"'),json_extract(formats_json,'$."image/png"')) IS NOT NULL;
INSERT OR IGNORE INTO `asset_versions` (`id`,`asset_id`,`version_number`,`source_url`,`mime_type`,`created_at`)
SELECT 'assetver_cover_gutenberg_'||id,'asset_cover_gutenberg_'||id,1,
COALESCE(json_extract(formats_json,'$."image/jpeg"'),json_extract(formats_json,'$."image/png"')),
CASE WHEN json_extract(formats_json,'$."image/jpeg"') IS NOT NULL THEN 'image/jpeg' ELSE 'image/png' END,first_ingested_at FROM catalog_books
WHERE COALESCE(json_extract(formats_json,'$."image/jpeg"'),json_extract(formats_json,'$."image/png"')) IS NOT NULL;
UPDATE digital_assets SET current_version_id='assetver_cover_gutenberg_'||substr(id,length('asset_cover_gutenberg_')+1) WHERE id LIKE 'asset_cover_gutenberg_%';

INSERT OR IGNORE INTO `catalog_search_documents` (`product_id`,`external_book_id`,`title`,`contributors_text`,`subjects_text`,`bookshelves_text`,`categories_text`,`languages_text`,`description`,`download_count`,`first_ingested_at`,`updated_at`)
SELECT 'prd_gutenberg_'||c.id,c.id,c.title,
COALESCE((SELECT group_concat(json_extract(a.value,'$.name'),' ') FROM json_each(c.authors_json) a),''),
COALESCE((SELECT group_concat(s.value,' | ') FROM json_each(c.subjects_json) s),''),
COALESCE((SELECT group_concat(b.value,' | ') FROM json_each(c.bookshelves_json) b),''),
trim(COALESCE((SELECT group_concat(s.value,' | ') FROM json_each(c.subjects_json) s),'')||' | '||COALESCE((SELECT group_concat(b.value,' | ') FROM json_each(c.bookshelves_json) b),''),' |'),
COALESCE((SELECT group_concat(l.value,' ') FROM json_each(c.languages_json) l),''),c.summary,c.download_count,c.first_ingested_at,c.updated_at
FROM catalog_books c;

-- Personal imports become private canonical products rather than opaque book_json blobs.
INSERT OR IGNORE INTO `works` (`id`,`title`,`description`,`created_at`,`updated_at`)
SELECT 'wrk_'||u.id,COALESCE(json_extract(u.book_json,'$.title'),'Personal import'),'Personal import',u.created_at,u.created_at FROM uploads u;
INSERT OR IGNORE INTO `editions` (`id`,`work_id`,`title`,`description`,`language`,`drm_status`,`downloadable`,`release_status`,`created_at`,`updated_at`)
SELECT 'ed_'||u.id,'wrk_'||u.id,COALESCE(json_extract(u.book_json,'$.title'),'Personal import'),'Personal import',COALESCE(json_extract(u.book_json,'$.languages[0]'),'en'),'none',1,'private',u.created_at,u.created_at FROM uploads u;
INSERT OR IGNORE INTO `products` (`id`,`edition_id`,`sku`,`format`,`storefront_status`,`source_name`,`source_external_id`,`created_at`,`updated_at`)
SELECT 'prd_'||u.id,'ed_'||u.id,'UPLOAD-'||u.id,'ebook','private','upload',u.id,u.created_at,u.created_at FROM uploads u;
INSERT OR IGNORE INTO `personal_imports` (`id`,`user_id`,`product_id`,`object_key`,`created_at`)
SELECT u.id,u.user_id,'prd_'||u.id,u.object_key,u.created_at FROM uploads u;
INSERT OR IGNORE INTO `external_identifiers` (`entity_type`,`entity_id`,`scheme`,`value`)
SELECT 'product','prd_'||u.id,'upload',u.id FROM uploads u;
INSERT OR IGNORE INTO `contributors` (`id`,`name`,`sort_name`,`created_at`,`updated_at`)
SELECT 'con_upload_'||u.id,COALESCE(json_extract(u.book_json,'$.authors[0].name'),'Unknown author'),COALESCE(json_extract(u.book_json,'$.authors[0].name'),'Unknown author'),u.created_at,u.created_at FROM uploads u;
INSERT OR IGNORE INTO `edition_contributors` (`edition_id`,`contributor_id`,`role`,`position`)
SELECT 'ed_'||u.id,'con_upload_'||u.id,'author',0 FROM uploads u;
INSERT OR IGNORE INTO `edition_languages` (`edition_id`,`language_code`,`kind`)
SELECT 'ed_'||u.id,COALESCE(json_extract(u.book_json,'$.languages[0]'),'en'),'content' FROM uploads u;
INSERT OR IGNORE INTO `entitlements` (`id`,`user_id`,`product_id`,`entitlement_type`,`status`,`source`,`granted_at`,`updated_at`)
SELECT 'ent_import_'||u.id,u.user_id,'prd_'||u.id,'personal-import','active','upload',u.created_at,u.created_at FROM uploads u;
INSERT OR IGNORE INTO `digital_assets` (`id`,`edition_id`,`kind`,`drm_status`,`downloadable`,`created_at`,`updated_at`)
SELECT 'asset_epub_'||u.id,'ed_'||u.id,'epub','none',1,u.created_at,u.created_at FROM uploads u;
INSERT OR IGNORE INTO `asset_versions` (`id`,`asset_id`,`version_number`,`object_key`,`mime_type`,`created_at`)
SELECT 'assetver_epub_'||u.id,'asset_epub_'||u.id,1,u.object_key,'application/epub+zip',u.created_at FROM uploads u;
UPDATE digital_assets SET current_version_id='assetver_epub_'||substr(id,length('asset_epub_')+1) WHERE id LIKE 'asset_epub_upload_%';
INSERT OR IGNORE INTO `catalog_search_documents` (`product_id`,`external_book_id`,`title`,`contributors_text`,`subjects_text`,`bookshelves_text`,`categories_text`,`languages_text`,`description`,`download_count`,`first_ingested_at`,`updated_at`)
SELECT 'prd_'||u.id,u.id,COALESCE(json_extract(u.book_json,'$.title'),'Personal import'),COALESCE(json_extract(u.book_json,'$.authors[0].name'),''),'Personal import','','Personal import',COALESCE(json_extract(u.book_json,'$.languages[0]'),'en'),'Personal import',0,u.created_at,u.created_at FROM uploads u;

-- Older Cove versions could save a remotely fetched Gutenberg title without putting it in catalog_books.
-- Recover those records from the old snapshots once, then stop using the snapshots as canonical data.
INSERT OR IGNORE INTO `works` (`id`,`title`,`description`,`created_at`,`updated_at`)
WITH legacy_books AS (
  SELECT book_id,book_json,updated_at stamp FROM library WHERE book_id NOT LIKE 'upload_%'
  UNION ALL SELECT book_id,book_json,added_at FROM shelf_books WHERE book_id NOT LIKE 'upload_%'
  UNION ALL SELECT book_id,book_json,finished_at FROM completions WHERE book_id NOT LIKE 'upload_%'
), picked AS (SELECT book_id,book_json,MIN(stamp) first_stamp,MAX(stamp) last_stamp FROM legacy_books GROUP BY book_id)
SELECT 'wrk_gutenberg_'||book_id,COALESCE(json_extract(book_json,'$.title'),'Gutenberg '||book_id),COALESCE(json_extract(book_json,'$.summaries[0]'),''),first_stamp,last_stamp FROM picked;
INSERT OR IGNORE INTO `editions` (`id`,`work_id`,`publisher_id`,`title`,`description`,`language`,`drm_status`,`downloadable`,`release_status`,`created_at`,`updated_at`)
WITH legacy_books AS (
  SELECT book_id,book_json,updated_at stamp FROM library WHERE book_id NOT LIKE 'upload_%'
  UNION ALL SELECT book_id,book_json,added_at FROM shelf_books WHERE book_id NOT LIKE 'upload_%'
  UNION ALL SELECT book_id,book_json,finished_at FROM completions WHERE book_id NOT LIKE 'upload_%'
), picked AS (SELECT book_id,book_json,MIN(stamp) first_stamp,MAX(stamp) last_stamp FROM legacy_books GROUP BY book_id)
SELECT 'ed_gutenberg_'||book_id,'wrk_gutenberg_'||book_id,'pub_project_gutenberg',COALESCE(json_extract(book_json,'$.title'),'Gutenberg '||book_id),COALESCE(json_extract(book_json,'$.summaries[0]'),''),COALESCE(json_extract(book_json,'$.languages[0]'),'en'),'none',1,'available',first_stamp,last_stamp FROM picked;
INSERT OR IGNORE INTO `products` (`id`,`edition_id`,`sku`,`format`,`storefront_status`,`source_name`,`source_external_id`,`created_at`,`updated_at`)
WITH legacy_books AS (
  SELECT book_id,book_json,updated_at stamp FROM library WHERE book_id NOT LIKE 'upload_%'
  UNION ALL SELECT book_id,book_json,added_at FROM shelf_books WHERE book_id NOT LIKE 'upload_%'
  UNION ALL SELECT book_id,book_json,finished_at FROM completions WHERE book_id NOT LIKE 'upload_%'
), picked AS (SELECT book_id,MIN(stamp) first_stamp,MAX(stamp) last_stamp FROM legacy_books GROUP BY book_id)
SELECT 'prd_gutenberg_'||book_id,'ed_gutenberg_'||book_id,'GUTENBERG-'||book_id,'ebook','active','gutenberg',book_id,first_stamp,last_stamp FROM picked;
INSERT OR IGNORE INTO `external_identifiers` (`entity_type`,`entity_id`,`scheme`,`value`)
SELECT 'product','prd_gutenberg_'||source_external_id,'gutenberg',source_external_id FROM products WHERE source_name='gutenberg';
INSERT OR IGNORE INTO `offers` (`id`,`product_id`,`offer_type`,`currency`,`amount_minor`,`active`,`created_at`,`updated_at`)
SELECT 'off_gutenberg_'||source_external_id,id,'public-domain','USD',0,1,created_at,updated_at FROM products WHERE source_name='gutenberg';
INSERT OR IGNORE INTO `rights_grants` (`id`,`edition_id`,`rightsholder_id`,`territory_code`,`format`,`sales_channel`,`license_type`,`drm_requirement`,`created_at`)
SELECT 'right_gutenberg_us_'||source_external_id,edition_id,'pub_project_gutenberg','US','ebook','retail','public-domain','none',created_at FROM products WHERE source_name='gutenberg';
INSERT OR IGNORE INTO `catalog_search_documents` (`product_id`,`external_book_id`,`title`,`contributors_text`,`subjects_text`,`bookshelves_text`,`categories_text`,`languages_text`,`description`,`download_count`,`first_ingested_at`,`updated_at`)
WITH legacy_books AS (
  SELECT book_id,book_json,updated_at stamp FROM library WHERE book_id NOT LIKE 'upload_%'
  UNION ALL SELECT book_id,book_json,added_at FROM shelf_books WHERE book_id NOT LIKE 'upload_%'
  UNION ALL SELECT book_id,book_json,finished_at FROM completions WHERE book_id NOT LIKE 'upload_%'
), picked AS (SELECT book_id,book_json,MIN(stamp) first_stamp,MAX(stamp) last_stamp FROM legacy_books GROUP BY book_id)
SELECT 'prd_gutenberg_'||book_id,book_id,COALESCE(json_extract(book_json,'$.title'),'Gutenberg '||book_id),COALESCE(json_extract(book_json,'$.authors[0].name'),''),
COALESCE((SELECT group_concat(value,' | ') FROM json_each(json_extract(book_json,'$.subjects'))),''),COALESCE((SELECT group_concat(value,' | ') FROM json_each(json_extract(book_json,'$.bookshelves'))),''),
trim(COALESCE((SELECT group_concat(value,' | ') FROM json_each(json_extract(book_json,'$.subjects'))),'')||' | '||COALESCE((SELECT group_concat(value,' | ') FROM json_each(json_extract(book_json,'$.bookshelves'))),''),' |'),
COALESCE((SELECT group_concat(value,' ') FROM json_each(json_extract(book_json,'$.languages'))),''),COALESCE(json_extract(book_json,'$.summaries[0]'),''),COALESCE(json_extract(book_json,'$.download_count'),0),first_stamp,last_stamp FROM picked;

-- Ownership/access is independent from the user's library presentation.
INSERT OR IGNORE INTO `entitlements` (`id`,`user_id`,`product_id`,`entitlement_type`,`status`,`source`,`granted_at`,`updated_at`)
SELECT 'ent_'||hex(user_id||':'||book_id),user_id,
CASE WHEN book_id LIKE 'upload_%' THEN 'prd_'||book_id ELSE 'prd_gutenberg_'||book_id END,
CASE WHEN book_id LIKE 'upload_%' THEN 'personal-import' ELSE 'public-domain' END,
'active','legacy-library',updated_at,updated_at FROM library;
INSERT OR IGNORE INTO `reading_states` (`user_id`,`product_id`,`external_book_id`,`in_library`,`status`,`progress`,`cfi`,`legacy_shelves_json`,`legacy_rating`,`legacy_review`,`review_migrated`,`updated_at`)
SELECT user_id,CASE WHEN book_id LIKE 'upload_%' THEN 'prd_'||book_id ELSE 'prd_gutenberg_'||book_id END,book_id,1,status,progress,cfi,shelves_json,rating,review,review_migrated,updated_at FROM library;

INSERT OR IGNORE INTO `shelf_items` (`shelf_id`,`product_id`,`external_book_id`,`position`,`note`,`added_at`)
SELECT shelf_id,CASE WHEN book_id LIKE 'upload_%' THEN 'prd_'||book_id ELSE 'prd_gutenberg_'||book_id END,book_id,position,note,added_at FROM shelf_books;
INSERT OR IGNORE INTO `completion_events` (`id`,`user_id`,`product_id`,`external_book_id`,`finished_at`)
SELECT id,user_id,CASE WHEN book_id LIKE 'upload_%' THEN 'prd_'||book_id ELSE 'prd_gutenberg_'||book_id END,book_id,finished_at FROM completions;

-- Commerce/publisher domain boundaries. These tables are intentionally present before paid
-- checkout is enabled so products, ownership, money, licensing, subscriptions and royalties
-- cannot collapse back into the reading/library records.
CREATE TABLE `prices` (
  `id` text PRIMARY KEY NOT NULL,
  `offer_id` text NOT NULL,
  `territory_code` text,
  `currency` text NOT NULL,
  `amount_minor` integer NOT NULL,
  `tax_inclusive` integer DEFAULT 0 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`offer_id`) REFERENCES `offers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`territory_code`) REFERENCES `territories`(`code`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `idx_prices_offer_territory_currency` ON `prices` (`offer_id`,`territory_code`,`currency`);
INSERT OR IGNORE INTO `prices` (`id`,`offer_id`,`territory_code`,`currency`,`amount_minor`,`tax_inclusive`,`created_at`,`updated_at`)
SELECT 'price_'||source_external_id,'off_gutenberg_'||source_external_id,'US','USD',0,0,created_at,updated_at FROM products WHERE source_name='gutenberg';

CREATE TABLE `orders` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `status` text NOT NULL,
  `currency` text NOT NULL,
  `subtotal_minor` integer NOT NULL,
  `tax_minor` integer DEFAULT 0 NOT NULL,
  `total_minor` integer NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
CREATE INDEX `idx_orders_user_date` ON `orders` (`user_id`,`created_at`);

CREATE TABLE `order_items` (
  `id` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL,
  `product_id` text NOT NULL,
  `offer_id` text,
  `unit_amount_minor` integer NOT NULL,
  `tax_minor` integer DEFAULT 0 NOT NULL,
  `quantity` integer DEFAULT 1 NOT NULL,
  `fulfillment_status` text DEFAULT 'pending' NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`offer_id`) REFERENCES `offers`(`id`) ON DELETE SET NULL
);
CREATE INDEX `idx_order_items_order` ON `order_items` (`order_id`);
CREATE INDEX `idx_order_items_product` ON `order_items` (`product_id`);

CREATE TABLE `payments` (
  `id` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL,
  `provider` text NOT NULL,
  `provider_payment_id` text,
  `status` text NOT NULL,
  `amount_minor` integer NOT NULL,
  `currency` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `idx_payments_provider_id` ON `payments` (`provider`,`provider_payment_id`);
CREATE INDEX `idx_payments_order` ON `payments` (`order_id`);

CREATE TABLE `refunds` (
  `id` text PRIMARY KEY NOT NULL,
  `payment_id` text NOT NULL,
  `order_item_id` text,
  `amount_minor` integer NOT NULL,
  `currency` text NOT NULL,
  `status` text NOT NULL,
  `reason` text DEFAULT '' NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON DELETE SET NULL
);
CREATE INDEX `idx_refunds_payment` ON `refunds` (`payment_id`);

CREATE TABLE `licenses` (
  `id` text PRIMARY KEY NOT NULL,
  `entitlement_id` text NOT NULL,
  `license_type` text NOT NULL,
  `drm_policy` text DEFAULT 'none' NOT NULL,
  `downloadable` integer DEFAULT 1 NOT NULL,
  `max_devices` integer,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`entitlement_id`) REFERENCES `entitlements`(`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `idx_licenses_entitlement` ON `licenses` (`entitlement_id`);

CREATE TABLE `devices` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `device_key` text NOT NULL,
  `name` text DEFAULT '' NOT NULL,
  `platform` text DEFAULT '' NOT NULL,
  `last_seen_at` text NOT NULL,
  `revoked_at` text,
  `created_at` text NOT NULL
);
CREATE UNIQUE INDEX `idx_devices_user_key` ON `devices` (`user_id`,`device_key`);

CREATE TABLE `subscriptions` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `plan_code` text NOT NULL,
  `status` text NOT NULL,
  `current_period_start` text NOT NULL,
  `current_period_end` text NOT NULL,
  `cancel_at_end` integer DEFAULT 0 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
CREATE INDEX `idx_subscriptions_user_status` ON `subscriptions` (`user_id`,`status`);

CREATE TABLE `subscription_catalog` (
  `product_id` text NOT NULL,
  `plan_code` text NOT NULL,
  `territory_code` text NOT NULL,
  `starts_at` text,
  `ends_at` text,
  PRIMARY KEY (`product_id`,`plan_code`,`territory_code`),
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`territory_code`) REFERENCES `territories`(`code`) ON DELETE CASCADE
);

CREATE TABLE `subscription_usage` (
  `id` text PRIMARY KEY NOT NULL,
  `subscription_id` text NOT NULL,
  `product_id` text NOT NULL,
  `metric` text NOT NULL,
  `quantity` real NOT NULL,
  `occurred_at` text NOT NULL,
  FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE RESTRICT
);
CREATE INDEX `idx_subscription_usage_period` ON `subscription_usage` (`subscription_id`,`occurred_at`);

CREATE TABLE `publisher_accounts` (
  `id` text PRIMARY KEY NOT NULL,
  `legal_name` text NOT NULL,
  `display_name` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `country_code` text,
  `tax_profile_status` text DEFAULT 'missing' NOT NULL,
  `payout_profile_status` text DEFAULT 'missing' NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);

CREATE TABLE `publisher_users` (
  `publisher_account_id` text NOT NULL,
  `user_id` text NOT NULL,
  `role` text NOT NULL,
  `status` text DEFAULT 'active' NOT NULL,
  `created_at` text NOT NULL,
  PRIMARY KEY (`publisher_account_id`,`user_id`),
  FOREIGN KEY (`publisher_account_id`) REFERENCES `publisher_accounts`(`id`) ON DELETE CASCADE
);

CREATE TABLE `royalty_contracts` (
  `id` text PRIMARY KEY NOT NULL,
  `publisher_account_id` text NOT NULL,
  `product_id` text,
  `territory_code` text,
  `channel` text NOT NULL,
  `rate_bps` integer NOT NULL,
  `terms_version` text NOT NULL,
  `effective_at` text NOT NULL,
  `ends_at` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`publisher_account_id`) REFERENCES `publisher_accounts`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE SET NULL,
  FOREIGN KEY (`territory_code`) REFERENCES `territories`(`code`) ON DELETE SET NULL
);
CREATE INDEX `idx_royalty_contract_lookup` ON `royalty_contracts` (`publisher_account_id`,`product_id`,`channel`,`effective_at`);

CREATE TABLE `royalty_events` (
  `id` text PRIMARY KEY NOT NULL,
  `publisher_account_id` text NOT NULL,
  `product_id` text NOT NULL,
  `order_item_id` text,
  `subscription_usage_id` text,
  `event_type` text NOT NULL,
  `gross_minor` integer DEFAULT 0 NOT NULL,
  `net_minor` integer DEFAULT 0 NOT NULL,
  `royalty_minor` integer NOT NULL,
  `currency` text NOT NULL,
  `occurred_at` text NOT NULL,
  FOREIGN KEY (`publisher_account_id`) REFERENCES `publisher_accounts`(`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON DELETE SET NULL,
  FOREIGN KEY (`subscription_usage_id`) REFERENCES `subscription_usage`(`id`) ON DELETE SET NULL
);
CREATE INDEX `idx_royalty_events_publisher_period` ON `royalty_events` (`publisher_account_id`,`occurred_at`);

CREATE TABLE `ledger_entries` (
  `id` text PRIMARY KEY NOT NULL,
  `account_type` text NOT NULL,
  `account_id` text NOT NULL,
  `order_id` text,
  `royalty_event_id` text,
  `entry_type` text NOT NULL,
  `amount_minor` integer NOT NULL,
  `currency` text NOT NULL,
  `occurred_at` text NOT NULL,
  `metadata_json` text DEFAULT '{}' NOT NULL,
  FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE SET NULL,
  FOREIGN KEY (`royalty_event_id`) REFERENCES `royalty_events`(`id`) ON DELETE SET NULL
);
CREATE INDEX `idx_ledger_account_period` ON `ledger_entries` (`account_type`,`account_id`,`occurred_at`);

CREATE TABLE `payouts` (
  `id` text PRIMARY KEY NOT NULL,
  `publisher_account_id` text NOT NULL,
  `status` text NOT NULL,
  `currency` text NOT NULL,
  `amount_minor` integer NOT NULL,
  `period_start` text NOT NULL,
  `period_end` text NOT NULL,
  `provider_reference` text,
  `created_at` text NOT NULL,
  `paid_at` text,
  FOREIGN KEY (`publisher_account_id`) REFERENCES `publisher_accounts`(`id`) ON DELETE RESTRICT
);
CREATE INDEX `idx_payouts_publisher_period` ON `payouts` (`publisher_account_id`,`period_end`);

CREATE TABLE `statements` (
  `id` text PRIMARY KEY NOT NULL,
  `publisher_account_id` text NOT NULL,
  `period_start` text NOT NULL,
  `period_end` text NOT NULL,
  `currency` text NOT NULL,
  `gross_minor` integer DEFAULT 0 NOT NULL,
  `refunds_minor` integer DEFAULT 0 NOT NULL,
  `royalties_minor` integer DEFAULT 0 NOT NULL,
  `payout_minor` integer DEFAULT 0 NOT NULL,
  `status` text DEFAULT 'draft' NOT NULL,
  `generated_at` text NOT NULL,
  FOREIGN KEY (`publisher_account_id`) REFERENCES `publisher_accounts`(`id`) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX `idx_statements_period` ON `statements` (`publisher_account_id`,`period_start`,`period_end`,`currency`);

-- Retire the old snapshot-shaped application model after all data has been copied.
ALTER TABLE `catalog_books` RENAME TO `gutenberg_source_cache`;
DROP TABLE `shelf_books`;
DROP TABLE `completions`;
DROP TABLE `uploads`;
DROP TABLE `library`;
DROP INDEX IF EXISTS `idx_catalog_books_popular`;
DROP INDEX IF EXISTS `idx_catalog_books_epub_queue`;
DROP INDEX IF EXISTS `idx_catalog_books_updated`;
CREATE INDEX `idx_gutenberg_source_cache_popular` ON `gutenberg_source_cache` (`download_count`);
CREATE INDEX `idx_gutenberg_source_cache_epub_queue` ON `gutenberg_source_cache` (`epub_status`,`epub_next_attempt_at`);
CREATE INDEX `idx_gutenberg_source_cache_updated` ON `gutenberg_source_cache` (`updated_at`);
