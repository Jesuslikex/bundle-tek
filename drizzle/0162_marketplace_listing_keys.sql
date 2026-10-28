-- Delivered private keys, sealed under MARKETPLACE_KEY_SECRET. Kept apart from
-- the publication record so the reviewed/hashed document does not change.
CREATE TABLE IF NOT EXISTS marketplace_listing_keys (
  publication_id TEXT PRIMARY KEY,
  sealed TEXT NOT NULL,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS marketplace_listing_keys_no_update
BEFORE UPDATE ON marketplace_listing_keys BEGIN
 SELECT RAISE(ABORT,'Marketplace listing keys are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS marketplace_listing_keys_no_delete
BEFORE DELETE ON marketplace_listing_keys BEGIN
 SELECT RAISE(ABORT,'Marketplace listing keys are immutable');
END;
