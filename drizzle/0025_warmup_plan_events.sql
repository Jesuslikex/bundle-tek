ALTER TABLE wallet_warmup_plans ADD COLUMN mutation_id TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
CREATE TABLE wallet_warmup_plan_events (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  type TEXT NOT NULL,
  revision INTEGER NOT NULL,
  document TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(owner_id,plan_id,revision)
);
