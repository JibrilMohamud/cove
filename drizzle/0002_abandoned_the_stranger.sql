CREATE TABLE `audio_editions` (
	`id` text PRIMARY KEY NOT NULL,
	`gutenberg_id` text NOT NULL,
	`book_id` text,
	`title` text NOT NULL,
	`authors_json` text NOT NULL,
	`language` text NOT NULL,
	`narration` text NOT NULL,
	`narrator` text DEFAULT '' NOT NULL,
	`source_url` text NOT NULL,
	`rights` text NOT NULL,
	`tracks_json` text NOT NULL,
	`alignment_json` text,
	`epub_sha256` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audio_book` ON `audio_editions` (`book_id`);--> statement-breakpoint
CREATE INDEX `idx_audio_narration` ON `audio_editions` (`narration`,`title`);--> statement-breakpoint
CREATE TABLE `book_metrics` (
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`word_count` integer NOT NULL,
	`reading_level` real,
	`language` text NOT NULL,
	`method` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `book_id`)
);
--> statement-breakpoint
CREATE TABLE `completions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`book_json` text NOT NULL,
	`finished_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_completions_user_date` ON `completions` (`user_id`,`finished_at`);--> statement-breakpoint
CREATE TABLE `playback` (
	`user_id` text NOT NULL,
	`edition_id` text NOT NULL,
	`track_id` text NOT NULL,
	`seconds` real NOT NULL,
	`speed` real DEFAULT 1 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `edition_id`),
	FOREIGN KEY (`edition_id`) REFERENCES `audio_editions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reading_goals` (
	`user_id` text NOT NULL,
	`year` integer NOT NULL,
	`books` integer NOT NULL,
	PRIMARY KEY(`user_id`, `year`)
);
--> statement-breakpoint
CREATE TABLE `reading_sessions` (
	`id` text NOT NULL,
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`mode` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text NOT NULL,
	`active_seconds` integer NOT NULL,
	`words_read` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_user_date` ON `reading_sessions` (`user_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `review_hearts` (
	`review_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`review_id`, `user_id`),
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hearts_recent` ON `review_hearts` (`review_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `review_reports` (
	`review_id` text NOT NULL,
	`user_id` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`review_id`, `user_id`),
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`rating_steps` integer,
	`body` text DEFAULT '' NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`spoiler` integer DEFAULT 0 NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`moderation` text DEFAULT 'visible' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "review_rating_steps" CHECK("reviews"."rating_steps" IS NULL OR "reviews"."rating_steps" BETWEEN 1 AND 10),
	CONSTRAINT "review_visibility" CHECK("reviews"."visibility" IN ('public','private'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reviews_user_book` ON `reviews` (`user_id`,`book_id`);--> statement-breakpoint
CREATE INDEX `idx_reviews_book_visibility` ON `reviews` (`book_id`,`visibility`,`moderation`,`created_at`);--> statement-breakpoint
CREATE TABLE `shelf_books` (
	`shelf_id` text NOT NULL,
	`book_id` text NOT NULL,
	`book_json` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`added_at` text NOT NULL,
	PRIMARY KEY(`shelf_id`, `book_id`),
	FOREIGN KEY (`shelf_id`) REFERENCES `shelves`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_shelf_order` ON `shelf_books` (`shelf_id`,`position`);--> statement-breakpoint
CREATE TABLE `shelves` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "shelf_visibility" CHECK("shelves"."visibility" IN ('public','private'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shelves_owner_name` ON `shelves` (`user_id`,`name`);--> statement-breakpoint
ALTER TABLE `library` ADD `review_migrated` integer DEFAULT 0 NOT NULL;