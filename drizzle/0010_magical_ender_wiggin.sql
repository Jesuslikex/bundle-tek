CREATE TABLE `project_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`chain` text NOT NULL,
	`launchpad` text NOT NULL,
	`type` text NOT NULL,
	`changes` text NOT NULL,
	`revision` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_project_events_owner_id` ON `project_events` (`owner_id`,`id`);--> statement-breakpoint
ALTER TABLE `workspace_projects` ADD `mutation_id` text DEFAULT 'legacy' NOT NULL;