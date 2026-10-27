CREATE TABLE IF NOT EXISTS marketplace_reservation_settlements (
  buyer_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  settled_at TEXT NOT NULL,
  wallet_count INTEGER NOT NULL,
  PRIMARY KEY (buyer_id, reservation_id)
);
