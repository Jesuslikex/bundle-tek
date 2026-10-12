CREATE TABLE imported_swap_signing_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, intent_id TEXT NOT NULL, preparation_id TEXT NOT NULL,
 project_id TEXT NOT NULL, project_revision INTEGER NOT NULL CHECK(project_revision>0), wallet_revision INTEGER NOT NULL CHECK(wallet_revision>0),
 wallet_address TEXT NOT NULL,
 type TEXT NOT NULL CHECK(type IN ('approval.baseline','approval.reviewed','approval.signed','approval.submission_started','approval.finalized','approval.failed','approval.cancelled')),
 state TEXT NOT NULL CHECK(state IN ('awaiting_signature','signed','submitted','finalized','failed','cancelled')),
 signature TEXT, document TEXT NOT NULL CHECK(json_valid(document) AND length(document)<=2048), created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX imported_swap_signing_events_owner ON imported_swap_signing_events(owner_id,created_at,sequence);
--> statement-breakpoint
CREATE INDEX imported_swap_signing_events_project ON imported_swap_signing_events(owner_id,project_id,created_at,sequence);
--> statement-breakpoint
CREATE INDEX imported_swap_signing_events_intent ON imported_swap_signing_events(owner_id,intent_id,sequence);
--> statement-breakpoint
-- Capture retained state only. Earlier transitions cannot be reconstructed.
INSERT INTO imported_swap_signing_events(id,owner_id,intent_id,preparation_id,project_id,project_revision,wallet_revision,wallet_address,type,state,signature,document,created_at)
SELECT lower(hex(randomblob(16))),i.owner_id,i.id,i.preparation_id,s.project_id,s.project_revision,s.wallet_revision,i.wallet_address,'approval.baseline',i.state,i.signature,
 json_object('side',json_extract(s.document,'$.side'),'sha256',json_extract(i.document,'$.sha256'),'inputMint',json_extract(i.document,'$.inputMint'),'outputMint',json_extract(i.document,'$.outputMint'),'inputRaw',json_extract(i.document,'$.inputRaw'),'minimumOutputRaw',json_extract(i.document,'$.minimumOutputRaw')),
 strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM imported_swap_signing_intents i JOIN imported_swap_preparations s ON s.owner_id=i.owner_id AND s.id=i.preparation_id;
--> statement-breakpoint
CREATE TRIGGER imported_swap_signing_event_insert AFTER INSERT ON imported_swap_signing_intents BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM imported_swap_preparations s WHERE s.owner_id=NEW.owner_id AND s.id=NEW.preparation_id AND s.wallet_address=NEW.wallet_address) THEN RAISE(ABORT,'Imported signing history context unavailable') END;
 INSERT INTO imported_swap_signing_events(id,owner_id,intent_id,preparation_id,project_id,project_revision,wallet_revision,wallet_address,type,state,signature,document,created_at)
 SELECT lower(hex(randomblob(16))),NEW.owner_id,NEW.id,NEW.preparation_id,s.project_id,s.project_revision,s.wallet_revision,NEW.wallet_address,
 CASE WHEN NEW.state='awaiting_signature' THEN 'approval.reviewed' ELSE 'approval.baseline' END,NEW.state,NEW.signature,
 json_object('side',json_extract(s.document,'$.side'),'sha256',json_extract(NEW.document,'$.sha256'),'inputMint',json_extract(NEW.document,'$.inputMint'),'outputMint',json_extract(NEW.document,'$.outputMint'),'inputRaw',json_extract(NEW.document,'$.inputRaw'),'minimumOutputRaw',json_extract(NEW.document,'$.minimumOutputRaw')),
 NEW.updated_at FROM imported_swap_preparations s WHERE s.owner_id=NEW.owner_id AND s.id=NEW.preparation_id;
END;
--> statement-breakpoint
-- Event persistence must commit with each state transition, including reservation before sending.
CREATE TRIGGER imported_swap_signing_event_transition AFTER UPDATE OF state ON imported_swap_signing_intents WHEN OLD.state<>NEW.state BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM imported_swap_preparations s WHERE s.owner_id=NEW.owner_id AND s.id=NEW.preparation_id AND s.wallet_address=NEW.wallet_address) THEN RAISE(ABORT,'Imported signing history context unavailable') END;
 INSERT INTO imported_swap_signing_events(id,owner_id,intent_id,preparation_id,project_id,project_revision,wallet_revision,wallet_address,type,state,signature,document,created_at)
 SELECT lower(hex(randomblob(16))),NEW.owner_id,NEW.id,NEW.preparation_id,s.project_id,s.project_revision,s.wallet_revision,NEW.wallet_address,
 CASE NEW.state WHEN 'signed' THEN 'approval.signed' WHEN 'submitted' THEN 'approval.submission_started' WHEN 'finalized' THEN 'approval.finalized' WHEN 'failed' THEN 'approval.failed' WHEN 'cancelled' THEN 'approval.cancelled' ELSE 'approval.reviewed' END,
 NEW.state,NEW.signature,
 json_object('side',json_extract(s.document,'$.side'),'sha256',json_extract(NEW.document,'$.sha256'),'inputMint',json_extract(NEW.document,'$.inputMint'),'outputMint',json_extract(NEW.document,'$.outputMint'),'inputRaw',json_extract(NEW.document,'$.inputRaw'),'minimumOutputRaw',json_extract(NEW.document,'$.minimumOutputRaw')),
 NEW.updated_at FROM imported_swap_preparations s WHERE s.owner_id=NEW.owner_id AND s.id=NEW.preparation_id;
END;
--> statement-breakpoint
CREATE TRIGGER imported_swap_signing_events_immutable_update BEFORE UPDATE ON imported_swap_signing_events BEGIN SELECT RAISE(ABORT,'Imported signing event is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER imported_swap_signing_events_immutable_delete BEFORE DELETE ON imported_swap_signing_events BEGIN SELECT RAISE(ABORT,'Imported signing event is immutable'); END;
