CREATE TABLE `pulse_cycles` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`network` text NOT NULL,
	`strategy` text NOT NULL,
	`slot` integer NOT NULL,
	`blockhash` text NOT NULL,
	`rpc_latency_ms` integer NOT NULL,
	`planned_orders` integer NOT NULL,
	`projected_turnover` real NOT NULL,
	`risk_score` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pulse_cycles_owner_created` ON `pulse_cycles` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `pulse_strategies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`strategy` text NOT NULL,
	`agents` integer NOT NULL,
	`budget` real NOT NULL,
	`cadence` integer NOT NULL,
	`order_size` real NOT NULL,
	`spread` integer NOT NULL,
	`inventory` integer NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	`network` text DEFAULT 'devnet' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pulse_strategies_owner` ON `pulse_strategies` (`owner_id`);