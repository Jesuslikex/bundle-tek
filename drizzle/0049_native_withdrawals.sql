-- Bridge existing swap ledgers into one execution lock without changing saved swap IDs.
CREATE TABLE solana_execution_reservations(owner_id TEXT NOT NULL,wallet_address TEXT NOT NULL,scope TEXT NOT NULL CHECK(scope IN ('warmup','imported','withdrawal')),intent_id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(owner_id,wallet_address));
--> statement-breakpoint
INSERT INTO solana_execution_reservations SELECT owner_id,wallet_address,scope,intent_id,state FROM solana_swap_reservations;
--> statement-breakpoint
CREATE TRIGGER solana_swap_execution_lock_insert BEFORE INSERT ON solana_swap_reservations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM solana_execution_reservations WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet_address) THEN RAISE(ABORT,'Wallet already reserved') END;
 INSERT INTO solana_execution_reservations VALUES(NEW.owner_id,NEW.wallet_address,NEW.scope,NEW.intent_id,NEW.state);
END;
--> statement-breakpoint
CREATE TRIGGER solana_swap_execution_lock_update AFTER UPDATE OF state ON solana_swap_reservations BEGIN
 UPDATE solana_execution_reservations SET state=NEW.state WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet_address AND scope=NEW.scope AND intent_id=NEW.intent_id;
END;
--> statement-breakpoint
CREATE TRIGGER solana_swap_execution_lock_delete AFTER DELETE ON solana_swap_reservations BEGIN
 DELETE FROM solana_execution_reservations WHERE owner_id=OLD.owner_id AND wallet_address=OLD.wallet_address AND scope=OLD.scope AND intent_id=OLD.intent_id;
END;
--> statement-breakpoint
CREATE TABLE solana_execution_signatures(owner_id TEXT NOT NULL,signature TEXT NOT NULL,scope TEXT NOT NULL,intent_id TEXT NOT NULL,PRIMARY KEY(owner_id,signature));
--> statement-breakpoint
INSERT INTO solana_execution_signatures SELECT owner_id,signature,scope,intent_id FROM solana_swap_signatures;
--> statement-breakpoint
CREATE TRIGGER solana_swap_execution_signature BEFORE INSERT ON solana_swap_signatures BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM solana_execution_signatures WHERE owner_id=NEW.owner_id AND signature=NEW.signature) THEN RAISE(ABORT,'Signature already registered') END;
 INSERT INTO solana_execution_signatures VALUES(NEW.owner_id,NEW.signature,NEW.scope,NEW.intent_id);
END;
--> statement-breakpoint
CREATE TABLE native_withdrawals(
 id TEXT PRIMARY KEY NOT NULL,owner_id TEXT NOT NULL,wallet_address TEXT NOT NULL,wallet_revision INTEGER NOT NULL CHECK(wallet_revision>0),
 document TEXT NOT NULL CHECK(json_valid(document) AND length(document)<=4096),
 state TEXT NOT NULL CHECK(state IN ('awaiting_signature','signing','signed','submitted','finalized','failed','cancelled')),
 signature TEXT,receipt TEXT CHECK(receipt IS NULL OR (json_valid(receipt) AND length(receipt)<=4096)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 CHECK((state IN ('awaiting_signature','signing','cancelled') AND signature IS NULL) OR (state IN ('signed','submitted','finalized','failed') AND signature IS NOT NULL)),
 CHECK((state='finalized' AND receipt IS NOT NULL) OR (state<>'finalized' AND receipt IS NULL)),UNIQUE(owner_id,signature)
);
--> statement-breakpoint
CREATE INDEX native_withdrawals_owner ON native_withdrawals(owner_id,created_at,id);
--> statement-breakpoint
CREATE INDEX native_withdrawals_wallet ON native_withdrawals(owner_id,wallet_address,created_at,id);
--> statement-breakpoint
CREATE TABLE native_withdrawal_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,owner_id TEXT NOT NULL,intent_id TEXT NOT NULL,wallet_address TEXT NOT NULL,state TEXT NOT NULL,signature TEXT,created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TRIGGER native_withdrawal_insert AFTER INSERT ON native_withdrawals BEGIN
 SELECT CASE WHEN NEW.state<>'awaiting_signature' THEN RAISE(ABORT,'Withdrawal must start unsigned') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM solana_execution_reservations WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet_address) THEN RAISE(ABORT,'Wallet already reserved') END;
 INSERT INTO solana_execution_reservations VALUES(NEW.owner_id,NEW.wallet_address,'withdrawal',NEW.id,NEW.state);
 INSERT INTO native_withdrawal_events(owner_id,intent_id,wallet_address,state,signature,created_at) VALUES(NEW.owner_id,NEW.id,NEW.wallet_address,NEW.state,NEW.signature,NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER native_withdrawal_identity BEFORE UPDATE ON native_withdrawals WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.wallet_address<>OLD.wallet_address OR NEW.wallet_revision<>OLD.wallet_revision OR NEW.document<>OLD.document OR NEW.created_at<>OLD.created_at OR (OLD.signature IS NOT NULL AND (NEW.signature IS NULL OR NEW.signature<>OLD.signature)) OR (OLD.receipt IS NOT NULL AND (NEW.receipt IS NULL OR NEW.receipt<>OLD.receipt)) BEGIN SELECT RAISE(ABORT,'Withdrawal context is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER native_withdrawal_transition AFTER UPDATE OF state ON native_withdrawals WHEN OLD.state<>NEW.state BEGIN
 SELECT CASE WHEN NOT ((OLD.state='awaiting_signature' AND NEW.state IN ('signing','cancelled')) OR (OLD.state='signing' AND NEW.state IN ('signed','cancelled')) OR (OLD.state='signed' AND NEW.state IN ('submitted','finalized','failed')) OR (OLD.state='submitted' AND NEW.state IN ('finalized','failed'))) THEN RAISE(ABORT,'Withdrawal state transition unavailable') END;
 UPDATE solana_execution_reservations SET state=NEW.state WHERE owner_id=NEW.owner_id AND scope='withdrawal' AND intent_id=NEW.id;
 DELETE FROM solana_execution_reservations WHERE owner_id=NEW.owner_id AND scope='withdrawal' AND intent_id=NEW.id AND NEW.state IN ('finalized','failed','cancelled');
 INSERT INTO native_withdrawal_events(owner_id,intent_id,wallet_address,state,signature,created_at) VALUES(NEW.owner_id,NEW.id,NEW.wallet_address,NEW.state,NEW.signature,NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER native_withdrawal_register BEFORE UPDATE OF signature ON native_withdrawals WHEN OLD.signature IS NULL AND NEW.signature IS NOT NULL BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM solana_execution_signatures WHERE owner_id=NEW.owner_id AND signature=NEW.signature) THEN RAISE(ABORT,'Signature already registered') END;
 INSERT INTO solana_execution_signatures VALUES(NEW.owner_id,NEW.signature,'withdrawal',NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER native_withdrawal_delete BEFORE DELETE ON native_withdrawals BEGIN SELECT RAISE(ABORT,'Withdrawal history is retained'); END;
--> statement-breakpoint
CREATE TRIGGER native_withdrawal_event_update BEFORE UPDATE ON native_withdrawal_events BEGIN SELECT RAISE(ABORT,'Withdrawal event is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER native_withdrawal_event_delete BEFORE DELETE ON native_withdrawal_events BEGIN SELECT RAISE(ABORT,'Withdrawal event is immutable'); END;
