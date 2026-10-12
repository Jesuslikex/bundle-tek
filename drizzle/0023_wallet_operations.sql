CREATE TABLE wallet_operations (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  kind TEXT NOT NULL,
  document TEXT NOT NULL,
  claim_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'preparing',
  signature TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  armed_at TEXT,
  minimum_slot INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_wallet_operation_active ON wallet_operations(owner_id,wallet_address) WHERE state IN ('preparing','awaiting_signature','submitted');
--> statement-breakpoint
CREATE UNIQUE INDEX idx_wallet_operation_signature ON wallet_operations(owner_id,signature);
--> statement-breakpoint
CREATE INDEX idx_wallet_operation_owner_updated ON wallet_operations(owner_id,updated_at DESC,id DESC);
