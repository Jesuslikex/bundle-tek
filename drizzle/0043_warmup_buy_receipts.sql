CREATE TABLE warmup_buy_receipts (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL,
 preparation_id TEXT NOT NULL,
 plan_id TEXT NOT NULL,
 plan_revision INTEGER NOT NULL,
 cycle INTEGER NOT NULL,
 wallet_address TEXT NOT NULL,
 wallet_revision INTEGER NOT NULL,
 signature TEXT NOT NULL,
 document TEXT NOT NULL CHECK(json_valid(document) AND length(document)<=8192),
 created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX warmup_buy_receipts_plan ON warmup_buy_receipts(owner_id,plan_id,created_at,id);
--> statement-breakpoint
CREATE UNIQUE INDEX warmup_buy_receipts_preparation ON warmup_buy_receipts(owner_id,preparation_id);
--> statement-breakpoint
CREATE UNIQUE INDEX warmup_buy_receipts_signature ON warmup_buy_receipts(owner_id,signature);
