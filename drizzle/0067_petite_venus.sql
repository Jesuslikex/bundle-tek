CREATE TABLE `holder_index_accounts` (
	`owner_id` text NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text NOT NULL,
	`address` text NOT NULL,
	PRIMARY KEY(`owner_id`, `project_id`, `run_id`, `address`)
);
--> statement-breakpoint
CREATE TABLE `holder_index_pages` (
	`owner_id` text NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text NOT NULL,
	`page` integer NOT NULL,
	`document` text NOT NULL,
	PRIMARY KEY(`owner_id`, `project_id`, `run_id`, `page`)
);
--> statement-breakpoint
CREATE TABLE `holder_index_runs` (
	`owner_id` text NOT NULL,
	`project_id` text NOT NULL,
	`id` text NOT NULL,
	`project_revision` integer NOT NULL,
	`document` text NOT NULL,
	`last_page` integer NOT NULL,
	`indexed_raw` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `project_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `holder_index_runs_recent` ON `holder_index_runs` (`owner_id`,`project_id`,`updated_at`);