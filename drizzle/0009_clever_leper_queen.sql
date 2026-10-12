CREATE TABLE `project_artwork` (
	`owner_id` text NOT NULL,
	`id` text NOT NULL,
	`data` blob NOT NULL,
	`mime` text NOT NULL,
	`byte_length` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_artwork_owner_id` ON `project_artwork` (`owner_id`,`id`);