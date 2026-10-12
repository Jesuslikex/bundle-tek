CREATE TABLE `tracked_wallets` (
	`owner_id` text NOT NULL,
	`address` text NOT NULL,
	`network` text NOT NULL,
	`label` text NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tracked_wallets_owner_address_network` ON `tracked_wallets` (`owner_id`,`address`,`network`);