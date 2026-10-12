CREATE TABLE warmup_signing_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 owner_id TEXT NOT NULL,
 intent_id TEXT NOT NULL,
 preparation_id TEXT NOT NULL,
 plan_id TEXT NOT NULL,
 plan_revision INTEGER NOT NULL,
 cycle INTEGER NOT NULL,
 wallet_address TEXT NOT NULL,
 type TEXT NOT NULL,
 state TEXT NOT NULL,
 signature TEXT,
 document TEXT NOT NULL CHECK(json_valid(document)),
 created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX warmup_signing_events_owner ON warmup_signing_events(owner_id,created_at,id);
--> statement-breakpoint
CREATE INDEX warmup_signing_events_intent ON warmup_signing_events(owner_id,intent_id,created_at,id);
--> statement-breakpoint
-- Existing rows establish a retained-state baseline, not reconstructed transitions.
INSERT INTO warmup_signing_events (id,owner_id,intent_id,preparation_id,plan_id,plan_revision,cycle,wallet_address,type,state,signature,document,created_at)
SELECT lower(hex(randomblob(16))),i.owner_id,i.id,i.preparation_id,s.plan_id,s.plan_revision,s.cycle,i.wallet_address,'approval.baseline',i.state,i.signature,
 json_object('side',json_extract(s.document,'$.side'),'sha256',json_extract(i.document,'$.sha256'),'inputMint',json_extract(i.document,'$.inputMint'),'outputMint',json_extract(i.document,'$.outputMint'),'inputRaw',json_extract(i.document,'$.inputRaw'),'minimumOutputRaw',json_extract(i.document,'$.minimumOutputRaw')),
 strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM warmup_signing_intents i JOIN warmup_swap_preparations s ON s.owner_id=i.owner_id AND s.id=i.preparation_id;
--> statement-breakpoint
CREATE TRIGGER warmup_signing_event_insert AFTER INSERT ON warmup_signing_intents BEGIN
 INSERT INTO warmup_signing_events (id,owner_id,intent_id,preparation_id,plan_id,plan_revision,cycle,wallet_address,type,state,signature,document,created_at)
 SELECT lower(hex(randomblob(16))),NEW.owner_id,NEW.id,NEW.preparation_id,s.plan_id,s.plan_revision,s.cycle,NEW.wallet_address,
 CASE WHEN NEW.state='awaiting_signature' THEN 'approval.reviewed' ELSE 'approval.baseline' END,NEW.state,NEW.signature,
 json_object('side',json_extract(s.document,'$.side'),'sha256',json_extract(NEW.document,'$.sha256'),'inputMint',json_extract(NEW.document,'$.inputMint'),'outputMint',json_extract(NEW.document,'$.outputMint'),'inputRaw',json_extract(NEW.document,'$.inputRaw'),'minimumOutputRaw',json_extract(NEW.document,'$.minimumOutputRaw')),
 NEW.updated_at
 FROM warmup_swap_preparations s WHERE s.owner_id=NEW.owner_id AND s.id=NEW.preparation_id;
END;
--> statement-breakpoint
-- The event and guarded state change commit together, including reservation before a send.
CREATE TRIGGER warmup_signing_event_transition AFTER UPDATE OF state ON warmup_signing_intents WHEN OLD.state<>NEW.state BEGIN
 INSERT INTO warmup_signing_events (id,owner_id,intent_id,preparation_id,plan_id,plan_revision,cycle,wallet_address,type,state,signature,document,created_at)
 SELECT lower(hex(randomblob(16))),NEW.owner_id,NEW.id,NEW.preparation_id,s.plan_id,s.plan_revision,s.cycle,NEW.wallet_address,
 CASE NEW.state WHEN 'signed' THEN 'approval.signed' WHEN 'submitted' THEN 'approval.submission_started' WHEN 'finalized' THEN 'approval.finalized' WHEN 'failed' THEN 'approval.failed' WHEN 'cancelled' THEN 'approval.cancelled' ELSE 'approval.reviewed' END,
 NEW.state,NEW.signature,
 json_object('side',json_extract(s.document,'$.side'),'sha256',json_extract(NEW.document,'$.sha256'),'inputMint',json_extract(NEW.document,'$.inputMint'),'outputMint',json_extract(NEW.document,'$.outputMint'),'inputRaw',json_extract(NEW.document,'$.inputRaw'),'minimumOutputRaw',json_extract(NEW.document,'$.minimumOutputRaw')),
 NEW.updated_at
 FROM warmup_swap_preparations s WHERE s.owner_id=NEW.owner_id AND s.id=NEW.preparation_id;
END;
