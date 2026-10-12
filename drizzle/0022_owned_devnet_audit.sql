ALTER TABLE wallet_challenges ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE wallet_challenges ADD COLUMN origin TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE wallet_challenges ADD COLUMN claim_nonce TEXT;
--> statement-breakpoint
ALTER TABLE wallet_audit_events ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
DROP INDEX IF EXISTS idx_wallet_audit_transaction;
--> statement-breakpoint
CREATE UNIQUE INDEX idx_wallet_audit_owner_transaction ON wallet_audit_events(owner_id, transaction_signature);
--> statement-breakpoint
CREATE INDEX idx_wallet_audit_owner_created ON wallet_audit_events(owner_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX idx_wallet_challenges_owner_address ON wallet_challenges(owner_id, wallet_address, expires_at);
--> statement-breakpoint
CREATE TABLE wallet_receipt_gates (owner_id TEXT PRIMARY KEY NOT NULL, claimed_at INTEGER NOT NULL);
