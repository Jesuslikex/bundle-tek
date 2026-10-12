ALTER TABLE warmup_buy_receipts ADD COLUMN remaining_raw TEXT;
--> statement-breakpoint
UPDATE warmup_buy_receipts SET remaining_raw=json_extract(document,'$.acquiredRaw');
--> statement-breakpoint
CREATE TABLE warmup_sell_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  preparation_id TEXT NOT NULL,
  buy_receipt_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  consumed_raw TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document) AND length(document)<=8192),
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX warmup_sell_receipts_preparation ON warmup_sell_receipts(owner_id,preparation_id);
--> statement-breakpoint
CREATE UNIQUE INDEX warmup_sell_receipts_signature ON warmup_sell_receipts(owner_id,signature);
--> statement-breakpoint
CREATE INDEX warmup_sell_receipts_lot ON warmup_sell_receipts(owner_id,buy_receipt_id);
--> statement-breakpoint
