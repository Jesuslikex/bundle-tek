CREATE TABLE tracked_wallet_transactions (
  owner_id TEXT NOT NULL,
  network TEXT NOT NULL,
  address TEXT NOT NULL,
  signature TEXT NOT NULL,
  document TEXT NOT NULL,
  wallet_updated_at TEXT NOT NULL,
  slot INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(owner_id,network,address,signature)
);
--> statement-breakpoint
CREATE INDEX idx_tracked_transactions_wallet_time ON tracked_wallet_transactions(owner_id,network,address,observed_at,signature);
