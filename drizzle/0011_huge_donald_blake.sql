CREATE TABLE `wallet_folders` (
	`owner_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`chain` text NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wallet_folders_owner_id` ON `wallet_folders` (`owner_id`,`id`);--> statement-breakpoint
CREATE TABLE `workspace_wallets` (
	`owner_id` text NOT NULL,
	`chain` text NOT NULL,
	`address` text NOT NULL,
	`folder_id` text NOT NULL,
	`label` text NOT NULL,
	`role` text NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workspace_wallets_owner_chain_address` ON `workspace_wallets` (`owner_id`,`chain`,`address`);--> statement-breakpoint
CREATE INDEX `idx_workspace_wallets_folder` ON `workspace_wallets` (`owner_id`,`folder_id`);