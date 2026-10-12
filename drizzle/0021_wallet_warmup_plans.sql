CREATE TABLE `wallet_warmup_plans` (
  `owner_id` text NOT NULL,
  `id` text NOT NULL,
  `document` text NOT NULL,
  `revision` integer NOT NULL DEFAULT 1,
  `archived` integer NOT NULL DEFAULT 0,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`owner_id`, `id`)
);
