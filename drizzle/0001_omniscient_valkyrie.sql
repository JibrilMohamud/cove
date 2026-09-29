CREATE TABLE `catalog_books` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`authors_json` text DEFAULT '[]' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`subjects_json` text DEFAULT '[]' NOT NULL,
	`bookshelves_json` text DEFAULT '[]' NOT NULL,
	`languages_json` text DEFAULT '[]' NOT NULL,
	`formats_json` text DEFAULT '{}' NOT NULL,
	`download_count` integer DEFAULT 0 NOT NULL,
	`copyright` integer,
	`source_url` text NOT NULL,
	`source_updated_at` text NOT NULL,
	`first_ingested_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`ingest_status` text DEFAULT 'active' NOT NULL,
	`ingest_attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`epub_status` text DEFAULT 'pending' NOT NULL,
	`epub_attempts` integer DEFAULT 0 NOT NULL,
	`epub_next_attempt_at` text DEFAULT '' NOT NULL,
	`epub_cached_at` text,
	`epub_last_error` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_catalog_books_popular` ON `catalog_books` (`download_count`);--> statement-breakpoint
CREATE INDEX `idx_catalog_books_epub_queue` ON `catalog_books` (`epub_status`,`epub_next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_catalog_books_updated` ON `catalog_books` (`updated_at`);--> statement-breakpoint
CREATE TABLE `catalog_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`next_url` text,
	`page` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`last_run_at` text,
	`last_success_at` text,
	`last_error` text DEFAULT '' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`total_catalog_count` integer DEFAULT 0 NOT NULL,
	`cycle_started_at` text,
	`next_run_at` text
);
