ALTER TABLE imported_swap_signing_intents ADD COLUMN failure_receipt TEXT CHECK(failure_receipt IS NULL OR (state='failed' AND json_valid(failure_receipt) AND length(failure_receipt)<=4096 AND json_extract(failure_receipt,'$.failed')=1));
--> statement-breakpoint
ALTER TABLE imported_swap_signing_events ADD COLUMN failure_receipt TEXT CHECK(failure_receipt IS NULL OR (state='failed' AND json_valid(failure_receipt) AND length(failure_receipt)<=4096));
--> statement-breakpoint
CREATE TRIGGER imported_swap_failure_immutable BEFORE UPDATE ON imported_swap_signing_intents WHEN OLD.failure_receipt IS NOT NULL AND (NEW.failure_receipt IS NULL OR NEW.failure_receipt<>OLD.failure_receipt) BEGIN SELECT RAISE(ABORT,'Imported swap failure evidence is immutable'); END;
--> statement-breakpoint
DROP TRIGGER imported_swap_signing_event_transition;
--> statement-breakpoint
CREATE TRIGGER imported_swap_signing_event_transition AFTER UPDATE OF state ON imported_swap_signing_intents WHEN OLD.state<>NEW.state BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM imported_swap_preparations s WHERE s.owner_id=NEW.owner_id AND s.id=NEW.preparation_id AND s.wallet_address=NEW.wallet_address) THEN RAISE(ABORT,'Imported signing history context unavailable') END;
 INSERT INTO imported_swap_signing_events(id,owner_id,intent_id,preparation_id,project_id,project_revision,wallet_revision,wallet_address,type,state,signature,document,created_at,failure_receipt)
 SELECT lower(hex(randomblob(16))),NEW.owner_id,NEW.id,NEW.preparation_id,s.project_id,s.project_revision,s.wallet_revision,NEW.wallet_address,
 CASE NEW.state WHEN 'signed' THEN 'approval.signed' WHEN 'submitted' THEN 'approval.submission_started' WHEN 'finalized' THEN 'approval.finalized' WHEN 'failed' THEN 'approval.failed' WHEN 'cancelled' THEN 'approval.cancelled' ELSE 'approval.reviewed' END,
 NEW.state,NEW.signature,
 json_object('side',json_extract(s.document,'$.side'),'sha256',json_extract(NEW.document,'$.sha256'),'inputMint',json_extract(NEW.document,'$.inputMint'),'outputMint',json_extract(NEW.document,'$.outputMint'),'inputRaw',json_extract(NEW.document,'$.inputRaw'),'minimumOutputRaw',json_extract(NEW.document,'$.minimumOutputRaw')),
 NEW.updated_at,NEW.failure_receipt FROM imported_swap_preparations s WHERE s.owner_id=NEW.owner_id AND s.id=NEW.preparation_id;
END;
--> statement-breakpoint
CREATE TRIGGER imported_swap_failure_recovery AFTER UPDATE OF failure_receipt ON imported_swap_signing_intents WHEN OLD.state='failed' AND NEW.state='failed' AND OLD.failure_receipt IS NULL AND NEW.failure_receipt IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM imported_swap_preparations s WHERE s.owner_id=NEW.owner_id AND s.id=NEW.preparation_id AND s.wallet_address=NEW.wallet_address) THEN RAISE(ABORT,'Imported signing history context unavailable') END;
 INSERT INTO imported_swap_signing_events(id,owner_id,intent_id,preparation_id,project_id,project_revision,wallet_revision,wallet_address,type,state,signature,document,created_at,failure_receipt)
 SELECT lower(hex(randomblob(16))),NEW.owner_id,NEW.id,NEW.preparation_id,s.project_id,s.project_revision,s.wallet_revision,NEW.wallet_address,
 CASE NEW.state WHEN 'signed' THEN 'approval.signed' WHEN 'submitted' THEN 'approval.submission_started' WHEN 'finalized' THEN 'approval.finalized' WHEN 'failed' THEN 'approval.failed' WHEN 'cancelled' THEN 'approval.cancelled' ELSE 'approval.reviewed' END,
 NEW.state,NEW.signature,
 json_object('side',json_extract(s.document,'$.side'),'sha256',json_extract(NEW.document,'$.sha256'),'inputMint',json_extract(NEW.document,'$.inputMint'),'outputMint',json_extract(NEW.document,'$.outputMint'),'inputRaw',json_extract(NEW.document,'$.inputRaw'),'minimumOutputRaw',json_extract(NEW.document,'$.minimumOutputRaw')),
 NEW.updated_at,NEW.failure_receipt FROM imported_swap_preparations s WHERE s.owner_id=NEW.owner_id AND s.id=NEW.preparation_id;
END;
