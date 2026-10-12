CREATE TABLE `wallet_balance_gates` (
	`owner_id` text NOT NULL,
	`next_allowed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wallet_balance_gate_owner` ON `wallet_balance_gates` (`owner_id`);--> statement-breakpoint
CREATE TABLE `wallet_balance_snapshots` (
	`owner_id` text NOT NULL,
	`chain` text NOT NULL,
	`address` text NOT NULL,
	`document` text NOT NULL,
	`block_number` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wallet_balance_owner_chain_address` ON `wallet_balance_snapshots` (`owner_id`,`chain`,`address`);