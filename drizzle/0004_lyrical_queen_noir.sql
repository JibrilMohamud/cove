CREATE TABLE `audio_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`last_error` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audio_jobs_queue` ON `audio_jobs` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `audio_timing` (
	`edition_id` text NOT NULL,
	`track_id` text NOT NULL,
	`audio_sha256` text NOT NULL,
	`epub_sha256` text NOT NULL,
	`map_sha256` text NOT NULL,
	`summary_json` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`edition_id`, `track_id`),
	FOREIGN KEY (`edition_id`) REFERENCES `audio_editions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `biosync_positions` (
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`edition_id` text NOT NULL,
	`mode` text NOT NULL,
	`cfi` text NOT NULL,
	`track_id` text NOT NULL,
	`seconds` real NOT NULL,
	`epub_sha256` text NOT NULL,
	`audio_sha256` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `book_id`)
);
