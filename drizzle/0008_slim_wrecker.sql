ALTER TABLE `tracked_wallets` ADD `group_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `tracked_wallets` ADD `icon` text DEFAULT '⭐' NOT NULL;--> statement-breakpoint
ALTER TABLE `tracked_wallets` ADD `favorite` integer DEFAULT false NOT NULL;