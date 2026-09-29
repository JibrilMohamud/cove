CREATE TABLE `annotations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`book_title` text NOT NULL,
	`author` text NOT NULL,
	`quote` text NOT NULL,
	`cfi` text NOT NULL,
	`chapter` text NOT NULL,
	`color` text NOT NULL,
	`note` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_annotations_user_book` ON `annotations` (`user_id`,`book_id`);--> statement-breakpoint
CREATE TABLE `api_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`word` text NOT NULL,
	`phonetic` text NOT NULL,
	`meaning` text NOT NULL,
	`part_of_speech` text NOT NULL,
	`book_id` text NOT NULL,
	`book_title` text NOT NULL,
	`cfi` text NOT NULL,
	`context` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_definitions_user_word` ON `definitions` (`user_id`,`word`);--> statement-breakpoint
CREATE TABLE `library` (
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`book_json` text NOT NULL,
	`status` text DEFAULT 'want-to-read' NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`cfi` text DEFAULT '' NOT NULL,
	`shelves_json` text DEFAULT '[]' NOT NULL,
	`rating` integer,
	`review` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `book_id`)
);
--> statement-breakpoint
CREATE TABLE `profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`book_json` text NOT NULL,
	`object_key` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_uploads_user` ON `uploads` (`user_id`);