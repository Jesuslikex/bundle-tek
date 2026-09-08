CREATE TABLE `workspace_projects` (
	`id` text NOT NULL,
	`owner_id` text NOT NULL,
	`document` text NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workspace_projects_owner_id` ON `workspace_projects` (`owner_id`,`id`);