CREATE TABLE `wallet_mint_holdings_snapshots` (
	`owner_id` text NOT NULL,
	`chain` text NOT NULL,
	`address` text NOT NULL,
	`mint` text NOT NULL,
	`document` text NOT NULL,
	`max_slot` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wallet_mint_holdings_owner_address_mint` ON `wallet_mint_holdings_snapshots` (`owner_id`,`chain`,`address`,`mint`);
