CREATE TABLE pump_organic_sequences (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 launch_review_id TEXT NOT NULL,
 mint TEXT NOT NULL,
 rent_allowance_raw TEXT NOT NULL,
 plan TEXT NOT NULL,
 plan_sha256 TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','stopped','complete')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX pump_organic_sequences_owner ON pump_organic_sequences(owner_id,project_id,created_at);
--> statement-breakpoint
CREATE TABLE pump_organic_batches (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL,
 sequence_id TEXT NOT NULL REFERENCES pump_organic_sequences(id),
 batch INTEGER NOT NULL,
 review TEXT NOT NULL,
 review_sha256 TEXT NOT NULL,
 consent TEXT,
 state TEXT NOT NULL CHECK(state IN ('review','signed','stopped','closed')),
 expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(sequence_id,batch)
);
--> statement-breakpoint
CREATE TABLE pump_organic_buys (
 owner_id TEXT NOT NULL,
 batch_id TEXT NOT NULL REFERENCES pump_organic_batches(id),
 buy_index INTEGER NOT NULL,
 holder TEXT NOT NULL,
 signed TEXT NOT NULL,
 signature TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('signed','submitting','submitted','finalized','failed','expired','cancelled')),
 receipt TEXT,
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(batch_id,buy_index)
);
--> statement-breakpoint
CREATE TRIGGER pump_organic_buys_immutable BEFORE UPDATE OF owner_id,batch_id,buy_index,holder,signed,signature ON pump_organic_buys BEGIN
 SELECT RAISE(ABORT,'Organic buy evidence is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER pump_organic_buys_transition BEFORE UPDATE OF state ON pump_organic_buys
WHEN NOT (
 (OLD.state='signed' AND NEW.state IN ('submitting','cancelled','expired'))
 OR (OLD.state='submitting' AND NEW.state IN ('submitted','finalized','failed','expired'))
 OR (OLD.state='submitted' AND NEW.state IN ('finalized','failed','expired'))
) BEGIN
 SELECT RAISE(ABORT,'Organic buy state transition is not allowed');
END;
--> statement-breakpoint
CREATE TRIGGER pump_organic_buys_send_guard BEFORE UPDATE OF state ON pump_organic_buys
WHEN NEW.state='submitting' AND EXISTS(SELECT 1 FROM pump_organic_batches b JOIN pump_organic_sequences s ON s.id=b.sequence_id WHERE b.id=NEW.batch_id AND (b.state<>'signed' OR s.state<>'active' OR b.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN
 SELECT RAISE(ABORT,'Organic batch is stopped, expired or not signed');
END;
--> statement-breakpoint
CREATE TRIGGER pump_organic_batches_review_immutable BEFORE UPDATE OF owner_id,sequence_id,batch,review,review_sha256,expires_at ON pump_organic_batches BEGIN
 SELECT RAISE(ABORT,'Organic batch review is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER pump_organic_sequence_reservation BEFORE INSERT ON pump_organic_sequences BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.plan,'$.rows') w WHERE
 EXISTS(SELECT 1 FROM solana_execution_reservations x WHERE x.owner_id=NEW.owner_id AND x.wallet_address=json_extract(w.value,'$.address'))
 OR EXISTS(SELECT 1 FROM pump_organic_sequences s,json_each(s.plan,'$.rows') o WHERE s.owner_id=NEW.owner_id AND json_extract(o.value,'$.address')=json_extract(w.value,'$.address')
 AND (s.state='active' OR EXISTS(SELECT 1 FROM pump_organic_buys b JOIN pump_organic_batches t ON t.id=b.batch_id WHERE t.sequence_id=s.id AND b.state IN ('signed','submitting','submitted'))))
 OR EXISTS(SELECT 1 FROM pump_launch_reviews r WHERE r.owner_id=NEW.owner_id AND r.state NOT IN ('cancelled','failed','finalized') AND (
 r.payer=json_extract(w.value,'$.address') OR EXISTS(SELECT 1 FROM json_each(r.review,'$.input.holders') h WHERE json_extract(h.value,'$.address')=json_extract(w.value,'$.address') AND json_extract(h.value,'$.kind')!='none'))))
 THEN RAISE(ABORT,'Organic holder wallet already reserved') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_organic_shared_reservation BEFORE INSERT ON solana_execution_reservations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pump_organic_sequences s,json_each(s.plan,'$.rows') o WHERE s.owner_id=NEW.owner_id AND json_extract(o.value,'$.address')=NEW.wallet_address
 AND (s.state='active' OR EXISTS(SELECT 1 FROM pump_organic_buys b JOIN pump_organic_batches t ON t.id=b.batch_id WHERE t.sequence_id=s.id AND b.state IN ('signed','submitting','submitted'))))
 THEN RAISE(ABORT,'Wallet reserved by an organic holder-buy sequence') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_organic_launch_reservation BEFORE INSERT ON pump_launch_reviews BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pump_organic_sequences s,json_each(s.plan,'$.rows') o WHERE s.owner_id=NEW.owner_id
 AND (s.state='active' OR EXISTS(SELECT 1 FROM pump_organic_buys b JOIN pump_organic_batches t ON t.id=b.batch_id WHERE t.sequence_id=s.id AND b.state IN ('signed','submitting','submitted')))
 AND (json_extract(o.value,'$.address')=NEW.payer OR EXISTS(SELECT 1 FROM json_each(NEW.review,'$.input.holders') h WHERE json_extract(h.value,'$.address')=json_extract(o.value,'$.address') AND json_extract(h.value,'$.kind')!='none')))
 THEN RAISE(ABORT,'Launch wallet reserved by an organic holder-buy sequence') END;
END;
