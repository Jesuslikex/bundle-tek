CREATE TABLE tracked_evm_snapshots (
  owner_id TEXT NOT NULL,
  network TEXT NOT NULL,
  address TEXT NOT NULL,
  document TEXT NOT NULL,
  wallet_updated_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,network,address)
);
--> statement-breakpoint
CREATE TABLE tracker_evm_read_gates (owner_id TEXT PRIMARY KEY NOT NULL,next_allowed_at INTEGER NOT NULL);
