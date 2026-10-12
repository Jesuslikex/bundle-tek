CREATE TABLE `wallet_ownership_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`chain` text NOT NULL,
	`address` text NOT NULL,
	`message` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`claim_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_wallet_ownership_challenge_owner` ON `wallet_ownership_challenges` (`owner_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `wallet_ownership_proofs` (
	`owner_id` text NOT NULL,
	`chain` text NOT NULL,
	`address` text NOT NULL,
	`verified_at` text NOT NULL,
	`challenge_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wallet_ownership_proof_account` ON `wallet_ownership_proofs` (`owner_id`,`chain`,`address`);