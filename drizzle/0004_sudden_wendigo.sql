CREATE TABLE `wallet_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`wallet_address` text NOT NULL,
	`network` text DEFAULT 'devnet' NOT NULL,
	`event_type` text NOT NULL,
	`transaction_signature` text,
	`details` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_wallet_audit_address_created` ON `wallet_audit_events` (`wallet_address`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wallet_audit_transaction` ON `wallet_audit_events` (`transaction_signature`);--> statement-breakpoint
CREATE TABLE `wallet_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`wallet_address` text NOT NULL,
	`message` text NOT NULL,
	`issued_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_wallet_challenges_address_expires` ON `wallet_challenges` (`wallet_address`,`expires_at`);