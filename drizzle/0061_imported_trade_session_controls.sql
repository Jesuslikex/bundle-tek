DROP TRIGGER session_event_saved;
--> statement-breakpoint
DROP TRIGGER session_event_cancelled;
--> statement-breakpoint
DROP TRIGGER session_event_reviewed;
--> statement-breakpoint
DROP TRIGGER session_event_transition;
--> statement-breakpoint
DROP TRIGGER session_event_keep_update;
--> statement-breakpoint
DROP TRIGGER session_event_keep_delete;
--> statement-breakpoint
CREATE TABLE imported_trade_session_events_next(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,owner_id TEXT NOT NULL,project_id TEXT NOT NULL,session_id TEXT NOT NULL,type TEXT NOT NULL CHECK(type IN ('session.baseline','session.saved','session.cancelled','session.paused','session.resumed','approval.reviewed','approval.signed','approval.submission_started','approval.finalized','approval.failed','approval.cancelled')),document TEXT NOT NULL CHECK(json_valid(document) AND length(document)<=18000),approval TEXT CHECK(approval IS NULL OR (json_valid(approval) AND length(approval)<=1024)),control TEXT CHECK(control IS NULL OR (json_valid(control) AND length(control)<=1024)),created_at TEXT NOT NULL);
--> statement-breakpoint
INSERT INTO imported_trade_session_events_next(sequence,id,owner_id,project_id,session_id,type,document,approval,created_at) SELECT sequence,id,owner_id,project_id,session_id,type,document,approval,created_at FROM imported_trade_session_events;
--> statement-breakpoint
DROP TABLE imported_trade_session_events;
--> statement-breakpoint
ALTER TABLE imported_trade_session_events_next RENAME TO imported_trade_session_events;
--> statement-breakpoint
CREATE INDEX imported_trade_session_events_owner ON imported_trade_session_events(owner_id,sequence);
--> statement-breakpoint
CREATE INDEX imported_trade_session_events_scope ON imported_trade_session_events(owner_id,project_id,session_id,sequence);
--> statement-breakpoint
CREATE TRIGGER session_event_saved AFTER INSERT ON imported_trade_sessions BEGIN INSERT INTO imported_trade_session_events(id,owner_id,project_id,session_id,type,document,approval,created_at) SELECT lower(hex(randomblob(16))),t.owner_id,t.project_id,t.id,'session.saved',json_object('id',t.id,'revision',t.revision,'state',t.state,'terms',json(t.document),'createdAt',t.created_at,'updatedAt',t.updated_at),NULL,NEW.created_at FROM imported_trade_sessions t WHERE t.owner_id=NEW.owner_id AND t.id=NEW.id; END;
--> statement-breakpoint
CREATE TRIGGER session_event_cancelled AFTER UPDATE OF state ON imported_trade_sessions WHEN OLD.state<>NEW.state BEGIN INSERT INTO imported_trade_session_events(id,owner_id,project_id,session_id,type,document,approval,created_at) SELECT lower(hex(randomblob(16))),t.owner_id,t.project_id,t.id,'session.cancelled',json_object('id',t.id,'revision',t.revision,'state',t.state,'terms',json(t.document),'createdAt',t.created_at,'updatedAt',t.updated_at),NULL,NEW.updated_at FROM imported_trade_sessions t WHERE t.owner_id=NEW.owner_id AND t.id=NEW.id; END;
--> statement-breakpoint
CREATE TRIGGER session_event_reviewed AFTER INSERT ON imported_swap_signing_intents WHEN json_type(NEW.document,'$.session') IS NOT NULL BEGIN INSERT INTO imported_trade_session_events(id,owner_id,project_id,session_id,type,document,approval,created_at) SELECT lower(hex(randomblob(16))),t.owner_id,t.project_id,t.id,CASE NEW.state WHEN 'awaiting_signature' THEN 'approval.reviewed' WHEN 'signed' THEN 'approval.signed' WHEN 'submitted' THEN 'approval.submission_started' WHEN 'finalized' THEN 'approval.finalized' WHEN 'failed' THEN 'approval.failed' WHEN 'cancelled' THEN 'approval.cancelled' END,json_object('id',t.id,'revision',t.revision,'state',t.state,'terms',json(t.document),'createdAt',t.created_at,'updatedAt',t.updated_at),json_object('id',NEW.id,'preparationId',NEW.preparation_id,'entry',json_extract(NEW.document,'$.session.entry'),'state',NEW.state,'signature',NEW.signature,'sha256',json_extract(NEW.document,'$.sha256'),'receiptId',(SELECT id FROM imported_swap_receipts WHERE owner_id=NEW.owner_id AND intent_id=NEW.id)),NEW.updated_at FROM imported_trade_sessions t WHERE t.owner_id=NEW.owner_id AND t.id=json_extract(NEW.document,'$.session.sessionId'); END;
--> statement-breakpoint
CREATE TRIGGER session_event_transition AFTER UPDATE OF state ON imported_swap_signing_intents WHEN OLD.state<>NEW.state AND json_type(NEW.document,'$.session') IS NOT NULL BEGIN INSERT INTO imported_trade_session_events(id,owner_id,project_id,session_id,type,document,approval,created_at) SELECT lower(hex(randomblob(16))),t.owner_id,t.project_id,t.id,CASE NEW.state WHEN 'awaiting_signature' THEN 'approval.reviewed' WHEN 'signed' THEN 'approval.signed' WHEN 'submitted' THEN 'approval.submission_started' WHEN 'finalized' THEN 'approval.finalized' WHEN 'failed' THEN 'approval.failed' WHEN 'cancelled' THEN 'approval.cancelled' END,json_object('id',t.id,'revision',t.revision,'state',t.state,'terms',json(t.document),'createdAt',t.created_at,'updatedAt',t.updated_at),json_object('id',NEW.id,'preparationId',NEW.preparation_id,'entry',json_extract(NEW.document,'$.session.entry'),'state',NEW.state,'signature',NEW.signature,'sha256',json_extract(NEW.document,'$.sha256'),'receiptId',(SELECT id FROM imported_swap_receipts WHERE owner_id=NEW.owner_id AND intent_id=NEW.id)),NEW.updated_at FROM imported_trade_sessions t WHERE t.owner_id=NEW.owner_id AND t.id=json_extract(NEW.document,'$.session.sessionId'); END;
--> statement-breakpoint
CREATE TRIGGER session_event_keep_update BEFORE UPDATE ON imported_trade_session_events BEGIN SELECT RAISE(ABORT,'Session event is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER session_event_keep_delete BEFORE DELETE ON imported_trade_session_events BEGIN SELECT RAISE(ABORT,'Session event is retained'); END;
--> statement-breakpoint
CREATE TABLE imported_trade_session_controls(owner_id TEXT NOT NULL,session_id TEXT NOT NULL,project_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('ready','paused')),revision INTEGER NOT NULL CHECK(revision>0 AND revision<1000000000),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_id,session_id));
--> statement-breakpoint
CREATE INDEX imported_trade_session_controls_project ON imported_trade_session_controls(owner_id,project_id);
--> statement-breakpoint
INSERT INTO imported_trade_session_controls SELECT owner_id,id,project_id,'ready',1,created_at,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM imported_trade_sessions;
--> statement-breakpoint
CREATE TRIGGER trade_session_control_init AFTER INSERT ON imported_trade_sessions BEGIN INSERT INTO imported_trade_session_controls VALUES(NEW.owner_id,NEW.id,NEW.project_id,'ready',1,NEW.created_at,NEW.created_at); END;
--> statement-breakpoint
CREATE TRIGGER trade_session_control_immutable BEFORE UPDATE ON imported_trade_session_controls WHEN NEW.owner_id<>OLD.owner_id OR NEW.session_id<>OLD.session_id OR NEW.project_id<>OLD.project_id OR NEW.created_at<>OLD.created_at OR NEW.revision<>OLD.revision+1 OR NEW.state=OLD.state OR julianday(NEW.updated_at)<julianday(OLD.updated_at) OR NOT EXISTS(SELECT 1 FROM imported_trade_sessions WHERE owner_id=OLD.owner_id AND id=OLD.session_id AND project_id=OLD.project_id AND state='active') BEGIN SELECT RAISE(ABORT,'Trade session control context differs'); END;
--> statement-breakpoint
CREATE TRIGGER trade_session_control_keep BEFORE DELETE ON imported_trade_session_controls BEGIN SELECT RAISE(ABORT,'Trade session control is retained'); END;
--> statement-breakpoint
CREATE TRIGGER trade_session_control_event AFTER UPDATE OF state ON imported_trade_session_controls WHEN OLD.state<>NEW.state BEGIN INSERT INTO imported_trade_session_events(id,owner_id,project_id,session_id,type,document,approval,control,created_at) SELECT lower(hex(randomblob(16))),t.owner_id,t.project_id,t.id,CASE NEW.state WHEN 'paused' THEN 'session.paused' ELSE 'session.resumed' END,json_object('id',t.id,'revision',t.revision,'state',t.state,'terms',json(t.document),'createdAt',t.created_at,'updatedAt',t.updated_at),NULL,json_object('sessionId',NEW.session_id,'projectId',NEW.project_id,'state',NEW.state,'revision',NEW.revision,'createdAt',NEW.created_at,'updatedAt',NEW.updated_at),NEW.updated_at FROM imported_trade_sessions t WHERE t.owner_id=NEW.owner_id AND t.id=NEW.session_id; END;
--> statement-breakpoint
CREATE TRIGGER trade_session_preparation_ready BEFORE INSERT ON imported_swap_preparations WHEN json_type(NEW.document,'$.session') IS NOT NULL BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM imported_trade_session_controls WHERE owner_id=NEW.owner_id AND session_id=json_extract(NEW.document,'$.session.sessionId') AND state='ready') THEN RAISE(ABORT,'Trade session is paused or unavailable') END; END;
--> statement-breakpoint
CREATE TRIGGER trade_session_approval_ready BEFORE INSERT ON imported_swap_signing_intents WHEN json_type(NEW.document,'$.session') IS NOT NULL BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM imported_trade_session_controls WHERE owner_id=NEW.owner_id AND session_id=json_extract(NEW.document,'$.session.sessionId') AND state='ready') THEN RAISE(ABORT,'Trade session is paused or unavailable') END; END;
--> statement-breakpoint
CREATE TRIGGER trade_session_submission_ready BEFORE UPDATE OF state ON imported_swap_signing_intents WHEN OLD.state<>NEW.state AND NEW.state='submitted' AND json_type(NEW.document,'$.session') IS NOT NULL BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM imported_trade_session_controls WHERE owner_id=NEW.owner_id AND session_id=json_extract(NEW.document,'$.session.sessionId') AND state='ready') THEN RAISE(ABORT,'Trade session is paused or unavailable') END; END;
