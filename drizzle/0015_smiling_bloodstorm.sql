CREATE TABLE `wallet_holdings_snapshots` (
	`owner_id` text NOT NULL,
	`chain` text NOT NULL,
	`address` text NOT NULL,
	`document` text NOT NULL,
	`max_slot` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wallet_holdings_owner_chain_address` ON `wallet_holdings_snapshots` (`owner_id`,`chain`,`address`);