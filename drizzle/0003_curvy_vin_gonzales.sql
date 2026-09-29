CREATE TABLE `auth_accounts` (
	`provider_id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`email` text NOT NULL,
	`username` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_accounts_app_id_unique` ON `auth_accounts` (`app_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `auth_accounts_username_unique` ON `auth_accounts` (`username`);