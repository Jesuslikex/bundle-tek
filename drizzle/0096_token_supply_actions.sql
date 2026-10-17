-- Burn and Streamflow lock of a share of a token's supply. Same lifecycle as native withdrawals: unsigned review, browser signing, separate submission, finalized receipt.
CREATE TABLE token_supply_actions(
 id TEXT PRIMARY KEY NOT NULL,owner_id TEXT NOT NULL,wallet_address TEXT NOT NULL,wallet_revision INTEGER NOT NULL CHECK(wallet_revision>0),
 kind TEXT NOT NULL CHECK(kind IN ('burn','lock')),mint TEXT NOT NULL,
 document TEXT NOT NULL CHECK(json_valid(document) AND length(document)<=6144 AND json_extract(document,'$.id')=id AND json_extract(document,'$.kind')=kind AND json_extract(document,'$.mint')=mint AND json_extract(document,'$.wallet')=wallet_address),
 state TEXT NOT NULL CHECK(state IN ('awaiting_signature','signing','signed','submitted','finalized','failed','cancelled')),
 signature TEXT,receipt TEXT CHECK(receipt IS NULL OR (json_valid(receipt) AND length(receipt)<=4096)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 CHECK((state IN ('awaiting_signature','signing','cancelled') AND signature IS NULL) OR (state IN ('signed','submitted','finalized','failed') AND signature IS NOT NULL)),
 CHECK((state='finalized' AND receipt IS NOT NULL AND json_extract(receipt,'$.failed')=0) OR (state='failed' AND (receipt IS NULL OR json_extract(receipt,'$.failed')=1)) OR (state NOT IN ('finalized','failed') AND receipt IS NULL)),
 UNIQUE(owner_id,signature)
);
--> statement-breakpoint
CREATE INDEX token_supply_actions_wallet ON token_supply_actions(owner_id,wallet_address,created_at,id);
--> statement-breakpoint
CREATE UNIQUE INDEX token_supply_actions_active ON token_supply_actions(owner_id,wallet_address) WHERE state IN ('awaiting_signature','signing','signed','submitted');
--> statement-breakpoint
CREATE TABLE token_supply_action_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,owner_id TEXT NOT NULL,intent_id TEXT NOT NULL,wallet_address TEXT NOT NULL,state TEXT NOT NULL,signature TEXT,created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TRIGGER token_supply_action_insert BEFORE INSERT ON token_supply_actions BEGIN
 SELECT CASE WHEN NEW.state<>'awaiting_signature' OR NEW.signature IS NOT NULL OR NEW.receipt IS NOT NULL THEN RAISE(ABORT,'Supply action must start unsigned') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM solana_execution_reservations WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet_address) THEN RAISE(ABORT,'Wallet already reserved') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pump_launch_reviews WHERE owner_id=NEW.owner_id AND payer=NEW.wallet_address AND state NOT IN ('cancelled','failed','finalized')) THEN RAISE(ABORT,'Wallet already reserved') END;
END;
--> statement-breakpoint
CREATE TRIGGER token_supply_action_inserted AFTER INSERT ON token_supply_actions BEGIN
 INSERT INTO token_supply_action_events(owner_id,intent_id,wallet_address,state,signature,created_at) VALUES(NEW.owner_id,NEW.id,NEW.wallet_address,NEW.state,NEW.signature,NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER token_supply_shared_reservation BEFORE INSERT ON solana_execution_reservations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM token_supply_actions WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet_address AND state IN ('awaiting_signature','signing','signed','submitted')) THEN RAISE(ABORT,'Wallet already reserved') END;
END;
--> statement-breakpoint
CREATE TRIGGER token_supply_launch_reservation BEFORE INSERT ON pump_launch_reviews BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM token_supply_actions WHERE owner_id=NEW.owner_id AND wallet_address=NEW.payer AND state IN ('awaiting_signature','signing','signed','submitted')) THEN RAISE(ABORT,'Payer already reserved') END;
END;
--> statement-breakpoint
CREATE TRIGGER token_supply_action_identity BEFORE UPDATE ON token_supply_actions WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.wallet_address<>OLD.wallet_address OR NEW.wallet_revision<>OLD.wallet_revision OR NEW.kind<>OLD.kind OR NEW.mint<>OLD.mint OR NEW.document<>OLD.document OR NEW.created_at<>OLD.created_at OR (OLD.signature IS NOT NULL AND (NEW.signature IS NULL OR NEW.signature<>OLD.signature)) OR (OLD.receipt IS NOT NULL AND (NEW.receipt IS NULL OR NEW.receipt<>OLD.receipt)) BEGIN SELECT RAISE(ABORT,'Supply action context is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER token_supply_action_transition AFTER UPDATE OF state ON token_supply_actions WHEN OLD.state<>NEW.state BEGIN
 SELECT CASE WHEN NOT ((OLD.state='awaiting_signature' AND NEW.state IN ('signing','cancelled')) OR (OLD.state='signing' AND NEW.state IN ('signed','cancelled')) OR (OLD.state='signed' AND NEW.state IN ('submitted','finalized','failed')) OR (OLD.state='submitted' AND NEW.state IN ('finalized','failed'))) THEN RAISE(ABORT,'Supply action state transition unavailable') END;
 INSERT INTO token_supply_action_events(owner_id,intent_id,wallet_address,state,signature,created_at) VALUES(NEW.owner_id,NEW.id,NEW.wallet_address,NEW.state,NEW.signature,NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER token_supply_action_register BEFORE UPDATE OF signature ON token_supply_actions WHEN OLD.signature IS NULL AND NEW.signature IS NOT NULL BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM solana_execution_signatures WHERE owner_id=NEW.owner_id AND signature=NEW.signature) THEN RAISE(ABORT,'Signature already registered') END;
 INSERT INTO solana_execution_signatures VALUES(NEW.owner_id,NEW.signature,'supply',NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER token_supply_action_delete BEFORE DELETE ON token_supply_actions BEGIN SELECT RAISE(ABORT,'Supply action history is retained'); END;
--> statement-breakpoint
CREATE TRIGGER token_supply_action_event_update BEFORE UPDATE ON token_supply_action_events BEGIN SELECT RAISE(ABORT,'Supply action event is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER token_supply_action_event_delete BEFORE DELETE ON token_supply_action_events BEGIN SELECT RAISE(ABORT,'Supply action event is immutable'); END;
