CREATE TABLE warmup_history_runs (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL,
  document TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'planned',
  revision INTEGER NOT NULL DEFAULT 1,
  lease_nonce TEXT,
  lease_until INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_warmup_history_active ON warmup_history_runs(owner_id,plan_id)
WHERE state IN ('planned','running','paused');
--> statement-breakpoint
CREATE INDEX idx_warmup_history_plan ON warmup_history_runs(owner_id,plan_id,created_at,id);
