CREATE TABLE `pulse_cycle_gates` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`claimed_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pulse_cycle_requests` (
	`owner_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`cycle_id` text,
	`claimed_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pulse_cycle_requests_owner_key` ON `pulse_cycle_requests` (`owner_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_pulse_cycle_requests_claimed` ON `pulse_cycle_requests` (`claimed_at`);