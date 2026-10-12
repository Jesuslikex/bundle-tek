CREATE TABLE warmup_swap_preparations (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL,
 plan_id TEXT NOT NULL,
 plan_revision INTEGER NOT NULL,
 cycle INTEGER NOT NULL,
 wallet_address TEXT NOT NULL,
 wallet_revision INTEGER NOT NULL,
 document TEXT NOT NULL CHECK(json_valid(document) AND length(document)<=8192),
 created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX warmup_swap_preparations_plan ON warmup_swap_preparations(owner_id,plan_id,created_at,id);
