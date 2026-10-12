CREATE TABLE imported_swap_signing_intents (
 id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, preparation_id TEXT NOT NULL,
 wallet_address TEXT NOT NULL, document TEXT NOT NULL CHECK(json_valid(document) AND length(document)<=8192),
 state TEXT NOT NULL CHECK(state IN ('awaiting_signature','signed','submitted','finalized','failed','cancelled')),
 signature TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX imported_swap_signing_preparation ON imported_swap_signing_intents(owner_id,preparation_id);
--> statement-breakpoint
CREATE UNIQUE INDEX imported_swap_signing_signature ON imported_swap_signing_intents(owner_id,signature) WHERE signature IS NOT NULL;
--> statement-breakpoint
CREATE TABLE imported_swap_receipts (
 id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, intent_id TEXT NOT NULL, preparation_id TEXT NOT NULL,
 project_id TEXT NOT NULL, project_revision INTEGER NOT NULL, wallet_revision INTEGER NOT NULL,
 signature TEXT NOT NULL, document TEXT NOT NULL CHECK(json_valid(document) AND length(document)<=16384), created_at TEXT NOT NULL,
 UNIQUE(owner_id,intent_id), UNIQUE(owner_id,signature)
);
--> statement-breakpoint
CREATE INDEX imported_swap_receipts_project ON imported_swap_receipts(owner_id,project_id,created_at,id);
--> statement-breakpoint
CREATE TABLE solana_swap_reservations (
 owner_id TEXT NOT NULL, wallet_address TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('warmup','imported')),
 intent_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('awaiting_signature','signed','submitted')),
 PRIMARY KEY(owner_id,wallet_address), UNIQUE(owner_id,scope,intent_id)
);
--> statement-breakpoint
INSERT INTO solana_swap_reservations SELECT owner_id,wallet_address,'warmup',id,state FROM warmup_signing_intents WHERE state IN ('awaiting_signature','signed','submitted');
--> statement-breakpoint
CREATE TABLE solana_swap_signatures (
 owner_id TEXT NOT NULL, signature TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('warmup','imported')), intent_id TEXT NOT NULL,
 PRIMARY KEY(owner_id,signature), UNIQUE(owner_id,scope,intent_id)
);
--> statement-breakpoint
INSERT INTO solana_swap_signatures SELECT owner_id,signature,'warmup',id FROM warmup_signing_intents WHERE signature IS NOT NULL;

--> statement-breakpoint
CREATE TRIGGER warmup_swap_reserve_insert BEFORE INSERT ON warmup_signing_intents WHEN NEW.state IN ('awaiting_signature','signed','submitted') BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM solana_swap_reservations WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet_address) THEN RAISE(ABORT,'Wallet already reserved') END;
 INSERT INTO solana_swap_reservations VALUES(NEW.owner_id,NEW.wallet_address,'warmup',NEW.id,NEW.state);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_swap_identity_immutable BEFORE UPDATE ON warmup_signing_intents WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.wallet_address<>OLD.wallet_address OR NEW.preparation_id<>OLD.preparation_id OR NEW.document<>OLD.document BEGIN
 SELECT RAISE(ABORT,'Approved context is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER warmup_swap_reserve_reactivate BEFORE UPDATE OF state ON warmup_signing_intents WHEN OLD.state NOT IN ('awaiting_signature','signed','submitted') AND NEW.state IN ('awaiting_signature','signed','submitted') BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM solana_swap_reservations WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet_address) THEN RAISE(ABORT,'Wallet already reserved') END;
 INSERT INTO solana_swap_reservations VALUES(NEW.owner_id,NEW.wallet_address,'warmup',NEW.id,NEW.state);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_swap_reserve_transition AFTER UPDATE OF state ON warmup_signing_intents WHEN OLD.state<>NEW.state BEGIN
 UPDATE solana_swap_reservations SET state=NEW.state WHERE owner_id=NEW.owner_id AND scope='warmup' AND intent_id=NEW.id AND NEW.state IN ('awaiting_signature','signed','submitted');
 DELETE FROM solana_swap_reservations WHERE owner_id=NEW.owner_id AND scope='warmup' AND intent_id=NEW.id AND NEW.state NOT IN ('awaiting_signature','signed','submitted');
END;

--> statement-breakpoint
CREATE TRIGGER imported_swap_reserve_insert BEFORE INSERT ON imported_swap_signing_intents WHEN NEW.state IN ('awaiting_signature','signed','submitted') BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM solana_swap_reservations WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet_address) THEN RAISE(ABORT,'Wallet already reserved') END;
 INSERT INTO solana_swap_reservations VALUES(NEW.owner_id,NEW.wallet_address,'imported',NEW.id,NEW.state);
END;
--> statement-breakpoint
CREATE TRIGGER imported_swap_identity_immutable BEFORE UPDATE ON imported_swap_signing_intents WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.wallet_address<>OLD.wallet_address OR NEW.preparation_id<>OLD.preparation_id OR NEW.document<>OLD.document BEGIN
 SELECT RAISE(ABORT,'Approved context is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER imported_swap_reserve_reactivate BEFORE UPDATE OF state ON imported_swap_signing_intents WHEN OLD.state NOT IN ('awaiting_signature','signed','submitted') AND NEW.state IN ('awaiting_signature','signed','submitted') BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM solana_swap_reservations WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet_address) THEN RAISE(ABORT,'Wallet already reserved') END;
 INSERT INTO solana_swap_reservations VALUES(NEW.owner_id,NEW.wallet_address,'imported',NEW.id,NEW.state);
END;
--> statement-breakpoint
CREATE TRIGGER imported_swap_reserve_transition AFTER UPDATE OF state ON imported_swap_signing_intents WHEN OLD.state<>NEW.state BEGIN
 UPDATE solana_swap_reservations SET state=NEW.state WHERE owner_id=NEW.owner_id AND scope='imported' AND intent_id=NEW.id AND NEW.state IN ('awaiting_signature','signed','submitted');
 DELETE FROM solana_swap_reservations WHERE owner_id=NEW.owner_id AND scope='imported' AND intent_id=NEW.id AND NEW.state NOT IN ('awaiting_signature','signed','submitted');
END;

--> statement-breakpoint
CREATE TRIGGER warmup_swap_signature_insert BEFORE INSERT ON warmup_signing_intents WHEN NEW.signature IS NOT NULL BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM solana_swap_signatures WHERE owner_id=NEW.owner_id AND signature=NEW.signature) THEN RAISE(ABORT,'Signature already registered') END;
 INSERT INTO solana_swap_signatures VALUES(NEW.owner_id,NEW.signature,'warmup',NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_swap_signature_register BEFORE UPDATE OF signature ON warmup_signing_intents WHEN NEW.signature IS NOT NULL AND OLD.signature IS NULL BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM solana_swap_signatures WHERE owner_id=NEW.owner_id AND signature=NEW.signature) THEN RAISE(ABORT,'Signature already registered') END;
 INSERT INTO solana_swap_signatures VALUES(NEW.owner_id,NEW.signature,'warmup',NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_swap_signature_immutable BEFORE UPDATE OF signature ON warmup_signing_intents WHEN OLD.signature IS NOT NULL AND (NEW.signature IS NULL OR NEW.signature<>OLD.signature) BEGIN
 SELECT RAISE(ABORT,'Registered signature is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER warmup_swap_reserve_delete AFTER DELETE ON warmup_signing_intents BEGIN
 DELETE FROM solana_swap_reservations WHERE owner_id=OLD.owner_id AND scope='warmup' AND intent_id=OLD.id;
END;

--> statement-breakpoint
CREATE TRIGGER imported_swap_signature_insert BEFORE INSERT ON imported_swap_signing_intents WHEN NEW.signature IS NOT NULL BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM solana_swap_signatures WHERE owner_id=NEW.owner_id AND signature=NEW.signature) THEN RAISE(ABORT,'Signature already registered') END;
 INSERT INTO solana_swap_signatures VALUES(NEW.owner_id,NEW.signature,'imported',NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER imported_swap_signature_register BEFORE UPDATE OF signature ON imported_swap_signing_intents WHEN NEW.signature IS NOT NULL AND OLD.signature IS NULL BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM solana_swap_signatures WHERE owner_id=NEW.owner_id AND signature=NEW.signature) THEN RAISE(ABORT,'Signature already registered') END;
 INSERT INTO solana_swap_signatures VALUES(NEW.owner_id,NEW.signature,'imported',NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER imported_swap_signature_immutable BEFORE UPDATE OF signature ON imported_swap_signing_intents WHEN OLD.signature IS NOT NULL AND (NEW.signature IS NULL OR NEW.signature<>OLD.signature) BEGIN
 SELECT RAISE(ABORT,'Registered signature is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER imported_swap_reserve_delete AFTER DELETE ON imported_swap_signing_intents BEGIN
 DELETE FROM solana_swap_reservations WHERE owner_id=OLD.owner_id AND scope='imported' AND intent_id=OLD.id;
END;


