CREATE TABLE pump_organic_sequences (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 mint TEXT NOT NULL,
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
