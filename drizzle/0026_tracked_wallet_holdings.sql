CREATE TABLE tracked_wallet_holdings (
  owner_id TEXT NOT NULL,
  network TEXT NOT NULL,
  address TEXT NOT NULL,
  document TEXT NOT NULL,
  wallet_updated_at TEXT NOT NULL,
  max_slot INTEGER NOT NULL,
  UNIQUE(owner_id,network,address)
);
