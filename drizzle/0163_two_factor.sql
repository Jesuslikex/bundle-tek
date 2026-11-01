-- better-auth twoFactor plugin (TOTP + backup codes). Additive only: existing
-- users default to two_factor_enabled = 0. Code reads these only when
-- BUNDLE_TWO_FACTOR_ENABLED=true.
ALTER TABLE `user` ADD `two_factor_enabled` integer DEFAULT false;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `two_factor` (
  `id` text PRIMARY KEY NOT NULL,
  `secret` text NOT NULL,
  `backup_codes` text NOT NULL,
  `user_id` text NOT NULL,
  `verified` integer DEFAULT true,
  `failed_verification_count` integer DEFAULT 0,
  `locked_until` integer,
  FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `two_factor_secret_idx` ON `two_factor` (`secret`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `two_factor_user_id_idx` ON `two_factor` (`user_id`);
