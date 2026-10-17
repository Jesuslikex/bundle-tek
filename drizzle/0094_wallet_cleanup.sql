CREATE TABLE wallet_cleanups(
 id TEXT PRIMARY KEY NOT NULL,owner_id TEXT NOT NULL,batch_id TEXT NOT NULL,wallet_address TEXT NOT NULL,wallet_revision INTEGER NOT NULL CHECK(wallet_revision>0),destination TEXT NOT NULL,
 document TEXT NOT NULL CHECK(json_valid(document) AND length(document)<=16384),
 state TEXT NOT NULL CHECK(state IN ('awaiting_signature','signing','signed','submitted','finalized','failed','cancelled')),
 signature TEXT,receipt TEXT CHECK(receipt IS NULL OR (json_valid(receipt) AND length(receipt)<=4096)),failure TEXT CHECK(failure IS NULL OR (json_valid(failure) AND length(failure)<=4096)),
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 CHECK(wallet_address<>destination),
 CHECK((state IN ('awaiting_signature','signing','cancelled') AND signature IS NULL) OR (state IN ('signed','submitted','finalized','failed') AND signature IS NOT NULL)),
 CHECK((state='finalized' AND receipt IS NOT NULL) OR (state<>'finalized' AND receipt IS NULL)),
 CHECK(failure IS NULL OR state='failed'),
 UNIQUE(owner_id,signature)
);
--> statement-breakpoint
CREATE INDEX wallet_cleanups_batch ON wallet_cleanups(owner_id,batch_id,created_at,id);
--> statement-breakpoint
CREATE INDEX wallet_cleanups_owner ON wallet_cleanups(owner_id,created_at,id);
--> statement-breakpoint
CREATE INDEX wallet_cleanups_active_wallet ON wallet_cleanups(owner_id,wallet_address,batch_id) WHERE state IN ('awaiting_signature','signing','signed','submitted');
--> statement-breakpoint
CREATE TRIGGER wallet_cleanup_insert BEFORE INSERT ON wallet_cleanups BEGIN
 SELECT CASE WHEN NEW.state<>'awaiting_signature' OR NEW.signature IS NOT NULL OR NEW.receipt IS NOT NULL OR NEW.failure IS NOT NULL THEN RAISE(ABORT,'Cleanup must start unsigned') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM solana_execution_reservations WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet_address) THEN RAISE(ABORT,'Wallet already reserved') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM wallet_cleanups WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet_address AND batch_id<>NEW.batch_id AND state IN ('awaiting_signature','signing','signed','submitted')) THEN RAISE(ABORT,'Wallet already reserved by another cleanup') END;
 SELECT CASE WHEN json_extract(NEW.document,'$.format')='wallet-cleanup-v1' AND EXISTS(SELECT 1 FROM wallet_cleanups WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet_address AND state IN ('awaiting_signature','signing','signed','submitted')) THEN RAISE(ABORT,'Wallet already reserved by another cleanup') END;
 SELECT CASE WHEN json_extract(NEW.document,'$.format') NOT IN ('wallet-cleanup-v1','wallet-cleanup-sell-v1') THEN RAISE(ABORT,'Unknown cleanup format') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pump_launch_reviews r WHERE r.owner_id=NEW.owner_id AND r.state NOT IN ('cancelled','failed','finalized') AND (r.payer=NEW.wallet_address OR NEW.wallet_address IN (
  SELECT json_extract(value,'$.address') FROM json_each(r.review,'$.input.holders') WHERE json_extract(r.review,'$.format') IN ('pump-create-holders-review-v1','pump-launch-group-review-v1') AND json_extract(value,'$.kind')!='none'))) THEN RAISE(ABORT,'Wallet reserved for launch') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_cleanup_shared_reservation BEFORE INSERT ON solana_execution_reservations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM wallet_cleanups WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet_address AND state IN ('awaiting_signature','signing','signed','submitted')) THEN RAISE(ABORT,'Wallet reserved for cleanup') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_cleanup_launch_reservation BEFORE INSERT ON pump_launch_reviews BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM wallet_cleanups c WHERE c.owner_id=NEW.owner_id AND c.state IN ('awaiting_signature','signing','signed','submitted') AND (c.wallet_address=NEW.payer OR c.wallet_address IN (
  SELECT json_extract(value,'$.address') FROM json_each(NEW.review,'$.input.holders') WHERE json_extract(NEW.review,'$.format') IN ('pump-create-holders-review-v1','pump-launch-group-review-v1') AND json_extract(value,'$.kind')!='none'))) THEN RAISE(ABORT,'Wallet reserved for cleanup') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_cleanup_identity BEFORE UPDATE ON wallet_cleanups WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.batch_id<>OLD.batch_id OR NEW.wallet_address<>OLD.wallet_address OR NEW.wallet_revision<>OLD.wallet_revision OR NEW.destination<>OLD.destination OR NEW.document<>OLD.document OR NEW.created_at<>OLD.created_at OR (OLD.signature IS NOT NULL AND (NEW.signature IS NULL OR NEW.signature<>OLD.signature)) OR (OLD.receipt IS NOT NULL AND (NEW.receipt IS NULL OR NEW.receipt<>OLD.receipt)) OR (OLD.failure IS NOT NULL AND (NEW.failure IS NULL OR NEW.failure<>OLD.failure)) BEGIN SELECT RAISE(ABORT,'Cleanup context is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER wallet_cleanup_transition BEFORE UPDATE OF state ON wallet_cleanups WHEN OLD.state<>NEW.state BEGIN
 SELECT CASE WHEN NOT ((OLD.state='awaiting_signature' AND NEW.state IN ('signing','cancelled')) OR (OLD.state='signing' AND NEW.state IN ('signed','cancelled')) OR (OLD.state='signed' AND NEW.state IN ('submitted','finalized','failed')) OR (OLD.state='submitted' AND NEW.state IN ('finalized','failed'))) THEN RAISE(ABORT,'Cleanup state transition unavailable') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_cleanup_register BEFORE UPDATE OF signature ON wallet_cleanups WHEN OLD.signature IS NULL AND NEW.signature IS NOT NULL BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM solana_execution_signatures WHERE owner_id=NEW.owner_id AND signature=NEW.signature) THEN RAISE(ABORT,'Signature already registered') END;
 INSERT INTO solana_execution_signatures VALUES(NEW.owner_id,NEW.signature,'cleanup',NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER wallet_cleanup_delete BEFORE DELETE ON wallet_cleanups BEGIN SELECT RAISE(ABORT,'Cleanup history is retained'); END;
