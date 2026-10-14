CREATE TABLE `launch_metadata_releases` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`project_id` text NOT NULL,
	`source_document` text NOT NULL,
	`metadata` text NOT NULL,
	`image` blob NOT NULL,
	`mime` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `launch_metadata_owner` ON `launch_metadata_releases` (`owner_id`,`project_id`);
--> statement-breakpoint
CREATE TRIGGER launch_metadata_no_update BEFORE UPDATE ON launch_metadata_releases
BEGIN SELECT RAISE(ABORT, 'Published token metadata is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER launch_metadata_no_delete BEFORE DELETE ON launch_metadata_releases
BEGIN SELECT RAISE(ABORT, 'Published token metadata is permanent'); END;
