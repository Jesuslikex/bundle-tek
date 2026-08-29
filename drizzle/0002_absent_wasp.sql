CREATE TABLE `launch_plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`chain` text NOT NULL,
	`launchpad` text NOT NULL,
	`currency` text NOT NULL,
	`token_name` text NOT NULL,
	`ticker` text NOT NULL,
	`description` text NOT NULL,
	`mode` text NOT NULL,
	`preset` text NOT NULL,
	`developer_buy` real NOT NULL,
	`holders_buy` real NOT NULL,
	`holder_count` integer NOT NULL,
	`routing_emphasis` integer NOT NULL,
	`use_husher` integer DEFAULT false NOT NULL,
	`scheduled` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_launch_plans_owner` ON `launch_plans` (`owner_id`);