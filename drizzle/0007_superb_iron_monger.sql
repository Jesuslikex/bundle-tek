CREATE TABLE `funding_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`name` text NOT NULL,
	`chain` text NOT NULL,
	`type` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_funding_events_owner_id` ON `funding_events` (`owner_id`,`id`);--> statement-breakpoint
CREATE TABLE `funding_plans` (
	`owner_id` text NOT NULL,
	`id` text NOT NULL,
	`document` text NOT NULL,
	`revision` integer NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`mutation_id` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_funding_owner_id` ON `funding_plans` (`owner_id`,`id`);