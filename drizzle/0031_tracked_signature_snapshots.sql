CREATE TABLE tracked_signature_snapshots (
 owner_id TEXT NOT NULL,network TEXT NOT NULL,address TEXT NOT NULL,document TEXT NOT NULL,
 wallet_updated_at TEXT NOT NULL,observed_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,network,address)
);
