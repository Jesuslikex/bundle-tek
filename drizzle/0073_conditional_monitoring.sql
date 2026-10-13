CREATE TABLE `conditional_monitor_jobs` (
	`owner_id` text NOT NULL,
	`project_id` text NOT NULL,
	`revision` integer NOT NULL,
	`project_revision` integer NOT NULL,
	`enabled` integer NOT NULL,
	`next_check_at` integer NOT NULL,
	`lease_token` text,
	`lease_until` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`last_checked_at` integer,
	`last_run_id` text,
	`match_keys` text DEFAULT '[]' NOT NULL,
	PRIMARY KEY(`owner_id`, `project_id`)
);
--> statement-breakpoint
CREATE INDEX `conditional_monitor_due` ON `conditional_monitor_jobs` (`enabled`,`next_check_at`,`lease_until`);--> statement-breakpoint
CREATE TABLE `conditional_monitor_notices` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`owner_id` text NOT NULL,
	`project_id` text NOT NULL,
	`document` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conditional_monitor_notices_id_unique` ON `conditional_monitor_notices` (`id`);--> statement-breakpoint
CREATE INDEX `conditional_monitor_notice_scope` ON `conditional_monitor_notices` (`owner_id`,`project_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `conditional_monitor_runtime` (
	`name` text PRIMARY KEY NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER conditional_monitor_notice_immutable BEFORE UPDATE ON conditional_monitor_notices BEGIN SELECT RAISE(ABORT,'Conditional match notices are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER conditional_monitor_notice_retained BEFORE DELETE ON conditional_monitor_notices BEGIN SELECT RAISE(ABORT,'Conditional match notices are retained'); END;
