CREATE TABLE volume_bot_sessions (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 project_revision INTEGER NOT NULL,
 mint TEXT NOT NULL,
 decimals INTEGER NOT NULL CHECK(decimals BETWEEN 0 AND 18),
 plan TEXT NOT NULL CHECK(json_valid(plan) AND json_extract(plan,'$.format')='volume-bot-plan-v1' AND json_type(plan,'$.wallets')='array'),
 plan_sha256 TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','cancelled','complete')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX volume_bot_sessions_owner ON volume_bot_sessions(owner_id,project_id,created_at);
--> statement-breakpoint
CREATE TABLE volume_bot_batches (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL,
 session_id TEXT NOT NULL REFERENCES volume_bot_sessions(id),
 batch INTEGER NOT NULL,
 review TEXT NOT NULL,
 review_sha256 TEXT NOT NULL,
 consent TEXT,
 state TEXT NOT NULL CHECK(state IN ('review','signed','cancelled','closed')),
 expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(session_id,batch)
);
--> statement-breakpoint
CREATE TABLE volume_bot_trades (
 owner_id TEXT NOT NULL,
 batch_id TEXT NOT NULL REFERENCES volume_bot_batches(id),
 trade_index INTEGER NOT NULL,
 round INTEGER NOT NULL,
 side TEXT NOT NULL CHECK(side IN ('Buy','Sell')),
 wallet TEXT NOT NULL,
 signed TEXT NOT NULL,
 signature TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('signed','submitting','submitted','finalized','failed','expired','cancelled')),
 receipt TEXT,
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(batch_id,trade_index)
);
--> statement-breakpoint
CREATE TRIGGER volume_bot_trades_immutable BEFORE UPDATE OF owner_id,batch_id,trade_index,round,side,wallet,signed,signature ON volume_bot_trades BEGIN
 SELECT RAISE(ABORT,'Volume trade evidence is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER volume_bot_trades_transition BEFORE UPDATE OF state ON volume_bot_trades
WHEN NOT (
 (OLD.state='signed' AND NEW.state IN ('submitting','cancelled','expired'))
 OR (OLD.state='submitting' AND NEW.state IN ('submitted','finalized','failed','expired'))
 OR (OLD.state='submitted' AND NEW.state IN ('finalized','failed','expired'))
) BEGIN
 SELECT RAISE(ABORT,'Volume trade state transition is not allowed');
END;
--> statement-breakpoint
CREATE TRIGGER volume_bot_trades_send_guard BEFORE UPDATE OF state ON volume_bot_trades
WHEN NEW.state='submitting' AND EXISTS(SELECT 1 FROM volume_bot_batches b JOIN volume_bot_sessions s ON s.id=b.session_id WHERE b.id=NEW.batch_id AND (b.state<>'signed' OR s.state<>'active' OR b.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN
 SELECT RAISE(ABORT,'Volume batch is cancelled, expired or not signed');
END;
--> statement-breakpoint
CREATE TRIGGER volume_bot_batches_review_immutable BEFORE UPDATE OF owner_id,session_id,batch,review,review_sha256,expires_at ON volume_bot_batches BEGIN
 SELECT RAISE(ABORT,'Volume batch review is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER volume_bot_batches_insert_guard BEFORE INSERT ON volume_bot_batches
WHEN NOT EXISTS(SELECT 1 FROM volume_bot_sessions s WHERE s.id=NEW.session_id AND s.owner_id=NEW.owner_id AND s.state='active')
 OR EXISTS(SELECT 1 FROM volume_bot_batches b WHERE b.session_id=NEW.session_id AND b.state IN ('review','signed') AND (b.state='signed' OR b.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN
 SELECT RAISE(ABORT,'Volume session is not active or another batch is still open');
END;
--> statement-breakpoint
CREATE TRIGGER volume_bot_session_reservation BEFORE INSERT ON volume_bot_sessions BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.plan,'$.wallets') w WHERE
 EXISTS(SELECT 1 FROM solana_execution_reservations x WHERE x.owner_id=NEW.owner_id AND x.wallet_address=w.value)
 OR EXISTS(SELECT 1 FROM volume_bot_sessions s,json_each(s.plan,'$.wallets') o WHERE s.owner_id=NEW.owner_id AND o.value=w.value
 AND (s.state='active' OR EXISTS(SELECT 1 FROM volume_bot_trades t JOIN volume_bot_batches b ON b.id=t.batch_id WHERE b.session_id=s.id AND t.state IN ('signed','submitting','submitted'))))
 OR EXISTS(SELECT 1 FROM pump_launch_reviews r WHERE r.owner_id=NEW.owner_id AND r.state NOT IN ('cancelled','failed','finalized') AND (
 r.payer=w.value OR EXISTS(SELECT 1 FROM json_each(r.review,'$.input.holders') h WHERE json_extract(h.value,'$.address')=w.value AND json_extract(h.value,'$.kind')!='none'))))
 THEN RAISE(ABORT,'Volume Bot wallet already reserved') END;
END;
--> statement-breakpoint
CREATE TRIGGER volume_bot_shared_reservation BEFORE INSERT ON solana_execution_reservations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM volume_bot_sessions s,json_each(s.plan,'$.wallets') o WHERE s.owner_id=NEW.owner_id AND o.value=NEW.wallet_address
 AND (s.state='active' OR EXISTS(SELECT 1 FROM volume_bot_trades t JOIN volume_bot_batches b ON b.id=t.batch_id WHERE b.session_id=s.id AND t.state IN ('signed','submitting','submitted'))))
 THEN RAISE(ABORT,'Wallet reserved by a Volume Bot session') END;
END;
--> statement-breakpoint
CREATE TRIGGER volume_bot_launch_reservation BEFORE INSERT ON pump_launch_reviews BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM volume_bot_sessions s,json_each(s.plan,'$.wallets') o WHERE s.owner_id=NEW.owner_id
 AND (s.state='active' OR EXISTS(SELECT 1 FROM volume_bot_trades t JOIN volume_bot_batches b ON b.id=t.batch_id WHERE b.session_id=s.id AND t.state IN ('signed','submitting','submitted')))
 AND (o.value=NEW.payer OR EXISTS(SELECT 1 FROM json_each(NEW.review,'$.input.holders') h WHERE json_extract(h.value,'$.address')=o.value AND json_extract(h.value,'$.kind')!='none')))
 THEN RAISE(ABORT,'Launch wallet reserved by a Volume Bot session') END;
END;
--> statement-breakpoint
CREATE TRIGGER volume_bot_organic_reservation BEFORE INSERT ON volume_bot_sessions BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.plan,'$.wallets') w,pump_organic_sequences s,json_each(s.plan,'$.rows') o
 WHERE s.owner_id=NEW.owner_id AND json_extract(o.value,'$.address')=w.value
 AND (s.state='active' OR EXISTS(SELECT 1 FROM pump_organic_buys b JOIN pump_organic_batches t ON t.id=b.batch_id WHERE t.sequence_id=s.id AND b.state IN ('signed','submitting','submitted'))))
 THEN RAISE(ABORT,'Volume Bot wallet reserved by an organic holder-buy sequence') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_organic_volume_reservation BEFORE INSERT ON pump_organic_sequences BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.plan,'$.rows') w,volume_bot_sessions s,json_each(s.plan,'$.wallets') o
 WHERE s.owner_id=NEW.owner_id AND o.value=json_extract(w.value,'$.address')
 AND (s.state='active' OR EXISTS(SELECT 1 FROM volume_bot_trades t JOIN volume_bot_batches b ON b.id=t.batch_id WHERE b.session_id=s.id AND t.state IN ('signed','submitting','submitted'))))
 THEN RAISE(ABORT,'Organic holder wallet reserved by a Volume Bot session') END;
END;
