-- Streamflow Airdrop cleanup: one wallet funds a merkle distributor (create), each output wallet claims its share (claim) and the creator can take back what is left (clawback). Same lifecycle as burns and locks: unsigned review, browser signing, separate submission, finalized receipt.
CREATE TABLE token_airdrop_actions(
 id TEXT PRIMARY KEY NOT NULL,owner_id TEXT NOT NULL,wallet_address TEXT NOT NULL,wallet_revision INTEGER NOT NULL CHECK(wallet_revision>0),
 kind TEXT NOT NULL CHECK(kind IN ('create','claim','clawback')),airdrop_id TEXT NOT NULL,mint TEXT NOT NULL,
 document TEXT NOT NULL CHECK(json_valid(document) AND length(document)<=8192 AND json_extract(document,'$.id')=id AND json_extract(document,'$.kind')=kind AND json_extract(document,'$.mint')=mint AND json_extract(document,'$.wallet')=wallet_address AND json_extract(document,'$.terms.airdropId')=airdrop_id),
 state TEXT NOT NULL CHECK(state IN ('awaiting_signature','signing','signed','submitted','finalized','failed','cancelled')),
 signature TEXT,receipt TEXT CHECK(receipt IS NULL OR (json_valid(receipt) AND length(receipt)<=4096)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 CHECK((kind='create')=(airdrop_id=id)),
 CHECK((state IN ('awaiting_signature','signing','cancelled') AND signature IS NULL) OR (state IN ('signed','submitted','finalized','failed') AND signature IS NOT NULL)),
 CHECK((state='finalized' AND receipt IS NOT NULL AND json_extract(receipt,'$.failed')=0) OR (state='failed' AND (receipt IS NULL OR json_extract(receipt,'$.failed')=1)) OR (state NOT IN ('finalized','failed') AND receipt IS NULL)),
 UNIQUE(owner_id,signature)
);
--> statement-breakpoint
CREATE INDEX token_airdrop_actions_wallet ON token_airdrop_actions(owner_id,wallet_address,created_at,id);
--> statement-breakpoint
CREATE INDEX token_airdrop_actions_airdrop ON token_airdrop_actions(owner_id,airdrop_id,created_at,id);
--> statement-breakpoint
CREATE UNIQUE INDEX token_airdrop_actions_active ON token_airdrop_actions(owner_id,wallet_address) WHERE state IN ('awaiting_signature','signing','signed','submitted');
--> statement-breakpoint
CREATE TABLE token_airdrop_action_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,owner_id TEXT NOT NULL,intent_id TEXT NOT NULL,wallet_address TEXT NOT NULL,state TEXT NOT NULL,signature TEXT,created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TRIGGER token_airdrop_action_insert BEFORE INSERT ON token_airdrop_actions BEGIN
 SELECT CASE WHEN NEW.state<>'awaiting_signature' OR NEW.signature IS NOT NULL OR NEW.receipt IS NOT NULL THEN RAISE(ABORT,'Airdrop action must start unsigned') END;
 SELECT CASE WHEN NEW.kind<>'create' AND NOT EXISTS(SELECT 1 FROM token_airdrop_actions c WHERE c.owner_id=NEW.owner_id AND c.id=NEW.airdrop_id AND c.kind='create' AND c.state='finalized' AND c.mint=NEW.mint AND ((NEW.kind='clawback' AND c.wallet_address=NEW.wallet_address) OR (NEW.kind='claim' AND EXISTS(SELECT 1 FROM json_each(c.document,'$.terms.recipients') r WHERE r.value=NEW.wallet_address)))) THEN RAISE(ABORT,'Airdrop parent unavailable') END;
 SELECT CASE WHEN NEW.kind='claim' AND EXISTS(SELECT 1 FROM token_airdrop_actions p WHERE p.owner_id=NEW.owner_id AND p.airdrop_id=NEW.airdrop_id AND p.kind='claim' AND p.wallet_address=NEW.wallet_address AND p.state='finalized') THEN RAISE(ABORT,'Airdrop share already claimed') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM solana_execution_reservations WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet_address) THEN RAISE(ABORT,'Wallet already reserved') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pump_launch_reviews WHERE owner_id=NEW.owner_id AND payer=NEW.wallet_address AND state NOT IN ('cancelled','failed','finalized')) THEN RAISE(ABORT,'Wallet already reserved') END;
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(SELECT 1 FROM solana_wallet_family_holds h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address);
 SELECT RAISE(ABORT,'Wallet reserved by same-block Volume') WHERE EXISTS(SELECT 1 FROM volume_bundle_reservations r WHERE r.owner_id=NEW.owner_id AND r.state IN ('held','attempted') AND r.wallet=NEW.wallet_address);
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address);
END;
--> statement-breakpoint
CREATE TRIGGER token_airdrop_action_inserted AFTER INSERT ON token_airdrop_actions BEGIN
 INSERT INTO token_airdrop_action_events(owner_id,intent_id,wallet_address,state,signature,created_at) VALUES(NEW.owner_id,NEW.id,NEW.wallet_address,NEW.state,NEW.signature,NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER token_airdrop_shared_reservation BEFORE INSERT ON solana_execution_reservations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM token_airdrop_actions WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet_address AND state IN ('awaiting_signature','signing','signed','submitted')) THEN RAISE(ABORT,'Wallet already reserved') END;
END;
--> statement-breakpoint
CREATE TRIGGER token_airdrop_launch_reservation BEFORE INSERT ON pump_launch_reviews BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM token_airdrop_actions WHERE owner_id=NEW.owner_id AND wallet_address=NEW.payer AND state IN ('awaiting_signature','signing','signed','submitted')) THEN RAISE(ABORT,'Payer already reserved') END;
END;
--> statement-breakpoint
CREATE TRIGGER token_airdrop_volume_reservation BEFORE INSERT ON volume_bundle_reservations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM token_airdrop_actions WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet AND state IN ('awaiting_signature','signing','signed','submitted')) THEN RAISE(ABORT,'Volume wallet already reserved by another flow') END;
END;
--> statement-breakpoint
CREATE TRIGGER token_airdrop_blocks_cleanup_insert BEFORE INSERT ON wallet_cleanups BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(SELECT 1 FROM token_airdrop_actions a WHERE a.owner_id=NEW.owner_id AND a.wallet_address=NEW.wallet_address AND a.state IN ('awaiting_signature','signing','signed','submitted'));
END;
--> statement-breakpoint
CREATE TRIGGER token_airdrop_blocks_cleanup_update BEFORE UPDATE OF state ON wallet_cleanups WHEN NEW.state IN ('signing','submitted') AND NEW.state<>OLD.state BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(SELECT 1 FROM token_airdrop_actions a WHERE a.owner_id=NEW.owner_id AND a.wallet_address=NEW.wallet_address AND a.state IN ('awaiting_signature','signing','signed','submitted'));
END;
--> statement-breakpoint
CREATE TRIGGER token_airdrop_blocks_supply_insert BEFORE INSERT ON token_supply_actions BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(SELECT 1 FROM token_airdrop_actions a WHERE a.owner_id=NEW.owner_id AND a.wallet_address=NEW.wallet_address AND a.state IN ('awaiting_signature','signing','signed','submitted'));
END;
--> statement-breakpoint
CREATE TRIGGER token_airdrop_blocks_supply_update BEFORE UPDATE OF state ON token_supply_actions WHEN NEW.state IN ('signing','submitted') AND NEW.state<>OLD.state BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(SELECT 1 FROM token_airdrop_actions a WHERE a.owner_id=NEW.owner_id AND a.wallet_address=NEW.wallet_address AND a.state IN ('awaiting_signature','signing','signed','submitted'));
END;
--> statement-breakpoint
CREATE TRIGGER token_airdrop_blocks_organic_insert BEFORE INSERT ON pump_organic_sequences BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(SELECT 1 FROM token_airdrop_actions a,json_each(NEW.plan,'$.rows') w WHERE a.owner_id=NEW.owner_id AND a.wallet_address=json_extract(w.value,'$.address') AND a.state IN ('awaiting_signature','signing','signed','submitted'));
END;
--> statement-breakpoint
CREATE TRIGGER token_airdrop_blocks_organic_send BEFORE UPDATE OF state ON pump_organic_buys WHEN NEW.state='submitting' AND OLD.state<>'submitting' BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(SELECT 1 FROM token_airdrop_actions a WHERE a.owner_id=NEW.owner_id AND a.wallet_address=NEW.holder AND a.state IN ('awaiting_signature','signing','signed','submitted'));
END;
--> statement-breakpoint
CREATE TRIGGER token_airdrop_blocks_volume_insert BEFORE INSERT ON volume_bot_sessions BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(SELECT 1 FROM token_airdrop_actions a,json_each(NEW.plan,'$.wallets') w WHERE a.owner_id=NEW.owner_id AND a.wallet_address=w.value AND a.state IN ('awaiting_signature','signing','signed','submitted'));
END;
--> statement-breakpoint
CREATE TRIGGER token_airdrop_blocks_volume_send BEFORE UPDATE OF state ON volume_bot_trades WHEN NEW.state='submitting' AND OLD.state<>'submitting' BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(SELECT 1 FROM token_airdrop_actions a WHERE a.owner_id=NEW.owner_id AND a.wallet_address=NEW.wallet AND a.state IN ('awaiting_signature','signing','signed','submitted'));
END;
--> statement-breakpoint
CREATE TRIGGER token_airdrop_blocks_warmup_lease BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r,json_each(r.document,'$.wallets') w JOIN token_airdrop_actions a ON a.owner_id=r.owner_id AND a.wallet_address=json_extract(w.value,'$.wallet') AND a.state IN ('awaiting_signature','signing','signed','submitted') WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id);
END;
--> statement-breakpoint
CREATE TRIGGER token_airdrop_action_identity BEFORE UPDATE ON token_airdrop_actions WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.wallet_address<>OLD.wallet_address OR NEW.wallet_revision<>OLD.wallet_revision OR NEW.kind<>OLD.kind OR NEW.airdrop_id<>OLD.airdrop_id OR NEW.mint<>OLD.mint OR NEW.document<>OLD.document OR NEW.created_at<>OLD.created_at OR (OLD.signature IS NOT NULL AND (NEW.signature IS NULL OR NEW.signature<>OLD.signature)) OR (OLD.receipt IS NOT NULL AND (NEW.receipt IS NULL OR NEW.receipt<>OLD.receipt)) BEGIN SELECT RAISE(ABORT,'Airdrop action context is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER token_airdrop_action_sign_or_send BEFORE UPDATE OF state ON token_airdrop_actions
WHEN NEW.state IN ('signing','submitted') AND NEW.state<>OLD.state BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(
 SELECT 1 FROM solana_wallet_family_holds h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address)
 OR EXISTS(SELECT 1 FROM solana_execution_reservations WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet_address);
 SELECT RAISE(ABORT,'Wallet reserved by same-block Volume') WHERE EXISTS(SELECT 1 FROM volume_bundle_reservations r WHERE r.owner_id=NEW.owner_id AND r.state IN ('held','attempted') AND r.wallet=NEW.wallet_address);
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address);
END;
--> statement-breakpoint
CREATE TRIGGER token_airdrop_action_transition AFTER UPDATE OF state ON token_airdrop_actions WHEN OLD.state<>NEW.state BEGIN
 SELECT CASE WHEN NOT ((OLD.state='awaiting_signature' AND NEW.state IN ('signing','cancelled')) OR (OLD.state='signing' AND NEW.state IN ('signed','cancelled')) OR (OLD.state='signed' AND NEW.state IN ('submitted','finalized','failed')) OR (OLD.state='submitted' AND NEW.state IN ('finalized','failed'))) THEN RAISE(ABORT,'Airdrop action state transition unavailable') END;
 INSERT INTO token_airdrop_action_events(owner_id,intent_id,wallet_address,state,signature,created_at) VALUES(NEW.owner_id,NEW.id,NEW.wallet_address,NEW.state,NEW.signature,NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER token_airdrop_action_register BEFORE UPDATE OF signature ON token_airdrop_actions WHEN OLD.signature IS NULL AND NEW.signature IS NOT NULL BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM solana_execution_signatures WHERE owner_id=NEW.owner_id AND signature=NEW.signature) THEN RAISE(ABORT,'Signature already registered') END;
 INSERT INTO solana_execution_signatures VALUES(NEW.owner_id,NEW.signature,'airdrop',NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER token_airdrop_action_delete BEFORE DELETE ON token_airdrop_actions BEGIN SELECT RAISE(ABORT,'Airdrop action history is retained'); END;
--> statement-breakpoint
CREATE TRIGGER token_airdrop_action_event_update BEFORE UPDATE ON token_airdrop_action_events BEGIN SELECT RAISE(ABORT,'Airdrop action event is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER token_airdrop_action_event_delete BEFORE DELETE ON token_airdrop_action_events BEGIN SELECT RAISE(ABORT,'Airdrop action event is immutable'); END;
