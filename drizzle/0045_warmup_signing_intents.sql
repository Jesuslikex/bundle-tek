CREATE TABLE warmup_signing_intents (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL,
 preparation_id TEXT NOT NULL,
 wallet_address TEXT NOT NULL,
 document TEXT NOT NULL CHECK(json_valid(document) AND length(document)<=8192),
 state TEXT NOT NULL CHECK(state IN ('awaiting_signature','signed','submitted','finalized','failed','cancelled')),
 signature TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX warmup_signing_intents_preparation ON warmup_signing_intents(owner_id,preparation_id);
--> statement-breakpoint
CREATE UNIQUE INDEX warmup_signing_intents_signature ON warmup_signing_intents(owner_id,signature) WHERE signature IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX warmup_signing_intents_active_wallet ON warmup_signing_intents(owner_id,wallet_address) WHERE state IN ('awaiting_signature','signed','submitted');
