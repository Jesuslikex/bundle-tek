ALTER TABLE imported_trade_lot_links ADD COLUMN write_token TEXT;
--> statement-breakpoint
CREATE TRIGGER imported_acquisition_write_guard BEFORE INSERT ON imported_trade_lot_links WHEN NEW.write_token IS NULL OR NOT EXISTS(SELECT 1 FROM imported_trade_lot_gates WHERE owner_id=NEW.owner_id AND project_id=NEW.project_id AND write_token=NEW.write_token) BEGIN SELECT RAISE(ABORT,'Acquisition write changed'); END;
--> statement-breakpoint
CREATE TRIGGER imported_acquisition_busy_wallet BEFORE INSERT ON imported_trade_lot_links WHEN EXISTS(SELECT 1 FROM solana_execution_reservations WHERE owner_id=NEW.owner_id AND wallet_address=(SELECT json_extract(document,'$.wallet') FROM imported_swap_receipts WHERE owner_id=NEW.owner_id AND id=NEW.buy_receipt_id)) AND NOT EXISTS(
 SELECT 1 FROM imported_swap_signing_intents i JOIN imported_swap_preparations p ON p.owner_id=i.owner_id AND p.id=i.preparation_id JOIN imported_swap_receipts s ON s.owner_id=i.owner_id AND s.intent_id=i.id
 WHERE i.owner_id=NEW.owner_id AND i.state IN ('signed','submitted') AND p.project_id=NEW.project_id AND s.id=NEW.sell_receipt_id AND i.signature=NEW.sell_signature
 AND json_extract(i.document,'$.acquisition.buyReceiptId')=NEW.buy_receipt_id AND json_extract(i.document,'$.acquisition.unitsRaw')=NEW.units_raw
 AND json_extract(i.document,'$.acquisition')=json_extract(p.document,'$.acquisition')
) BEGIN SELECT RAISE(ABORT,'Wallet approval holds acquisition accounting'); END;
--> statement-breakpoint
CREATE TRIGGER imported_acquisition_approval_context BEFORE INSERT ON imported_swap_signing_intents WHEN EXISTS(SELECT 1 FROM imported_swap_preparations WHERE owner_id=NEW.owner_id AND id=NEW.preparation_id AND json_type(document,'$.acquisition') IS NOT NULL) OR json_type(NEW.document,'$.acquisition') IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM imported_swap_preparations p JOIN imported_swap_receipts b ON b.owner_id=p.owner_id AND b.project_id=p.project_id AND b.id=json_extract(p.document,'$.acquisition.buyReceiptId') WHERE p.owner_id=NEW.owner_id AND p.id=NEW.preparation_id AND json_extract(p.document,'$.side')='Sell' AND json_extract(p.document,'$.acquisition')=json_extract(NEW.document,'$.acquisition') AND json_extract(NEW.document,'$.inputRaw')=json_extract(p.document,'$.acquisition.unitsRaw') AND NEW.wallet_address=json_extract(b.document,'$.wallet') AND p.project_id=json_extract(p.document,'$.acquisition.projectId') AND json_extract(b.document,'$.mint')=json_extract(p.document,'$.inputMint') AND json_extract(b.document,'$.signature')=json_extract(p.document,'$.acquisition.buySignature') AND json_extract(b.document,'$.preparationSha256')=json_extract(p.document,'$.acquisition.buyPreparationSha256') AND COALESCE((SELECT revision FROM imported_trade_lot_gates WHERE owner_id=NEW.owner_id AND project_id=p.project_id),0)=json_extract(p.document,'$.acquisition.linkRevision')) THEN RAISE(ABORT,'Reviewed acquisition context differs') END;
END;
--> statement-breakpoint
CREATE TRIGGER imported_acquisition_reserved_receipt_update BEFORE UPDATE ON imported_swap_receipts WHEN EXISTS(SELECT 1 FROM imported_swap_signing_intents WHERE owner_id=OLD.owner_id AND state IN ('awaiting_signature','signed','submitted') AND json_extract(document,'$.acquisition.buyReceiptId')=OLD.id) BEGIN SELECT RAISE(ABORT,'Approved acquisition evidence is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER imported_acquisition_reserved_receipt_delete BEFORE DELETE ON imported_swap_receipts WHEN EXISTS(SELECT 1 FROM imported_swap_signing_intents WHERE owner_id=OLD.owner_id AND state IN ('awaiting_signature','signed','submitted') AND json_extract(document,'$.acquisition.buyReceiptId')=OLD.id) BEGIN SELECT RAISE(ABORT,'Approved acquisition evidence is immutable'); END;

--> statement-breakpoint
DROP TRIGGER IF EXISTS imported_swap_signing_event_insert;
--> statement-breakpoint
CREATE TRIGGER imported_swap_signing_event_insert AFTER INSERT ON imported_swap_signing_intents BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM imported_swap_preparations s WHERE s.owner_id=NEW.owner_id AND s.id=NEW.preparation_id AND s.wallet_address=NEW.wallet_address) THEN RAISE(ABORT,'Imported signing history context unavailable') END;
 INSERT INTO imported_swap_signing_events(id,owner_id,intent_id,preparation_id,project_id,project_revision,wallet_revision,wallet_address,type,state,signature,document,created_at)
 SELECT lower(hex(randomblob(16))),NEW.owner_id,NEW.id,NEW.preparation_id,s.project_id,s.project_revision,s.wallet_revision,NEW.wallet_address,
 CASE WHEN NEW.state='awaiting_signature' THEN 'approval.reviewed' ELSE 'approval.baseline' END,NEW.state,NEW.signature,
 json_object('side',json_extract(s.document,'$.side'),'sha256',json_extract(NEW.document,'$.sha256'),'inputMint',json_extract(NEW.document,'$.inputMint'),'outputMint',json_extract(NEW.document,'$.outputMint'),'inputRaw',json_extract(NEW.document,'$.inputRaw'),'minimumOutputRaw',json_extract(NEW.document,'$.minimumOutputRaw'),'acquisition',json_extract(NEW.document,'$.acquisition')),
 NEW.updated_at FROM imported_swap_preparations s WHERE s.owner_id=NEW.owner_id AND s.id=NEW.preparation_id;
END;

--> statement-breakpoint
DROP TRIGGER IF EXISTS imported_swap_signing_event_transition;
--> statement-breakpoint
-- Event persistence must commit with each state transition, including reservation before sending.
CREATE TRIGGER imported_swap_signing_event_transition AFTER UPDATE OF state ON imported_swap_signing_intents WHEN OLD.state<>NEW.state BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM imported_swap_preparations s WHERE s.owner_id=NEW.owner_id AND s.id=NEW.preparation_id AND s.wallet_address=NEW.wallet_address) THEN RAISE(ABORT,'Imported signing history context unavailable') END;
 INSERT INTO imported_swap_signing_events(id,owner_id,intent_id,preparation_id,project_id,project_revision,wallet_revision,wallet_address,type,state,signature,document,created_at)
 SELECT lower(hex(randomblob(16))),NEW.owner_id,NEW.id,NEW.preparation_id,s.project_id,s.project_revision,s.wallet_revision,NEW.wallet_address,
 CASE NEW.state WHEN 'signed' THEN 'approval.signed' WHEN 'submitted' THEN 'approval.submission_started' WHEN 'finalized' THEN 'approval.finalized' WHEN 'failed' THEN 'approval.failed' WHEN 'cancelled' THEN 'approval.cancelled' ELSE 'approval.reviewed' END,
 NEW.state,NEW.signature,
 json_object('side',json_extract(s.document,'$.side'),'sha256',json_extract(NEW.document,'$.sha256'),'inputMint',json_extract(NEW.document,'$.inputMint'),'outputMint',json_extract(NEW.document,'$.outputMint'),'inputRaw',json_extract(NEW.document,'$.inputRaw'),'minimumOutputRaw',json_extract(NEW.document,'$.minimumOutputRaw'),'acquisition',json_extract(NEW.document,'$.acquisition')),
 NEW.updated_at FROM imported_swap_preparations s WHERE s.owner_id=NEW.owner_id AND s.id=NEW.preparation_id;
END;

--> statement-breakpoint
CREATE TRIGGER imported_acquisition_intent_immutable BEFORE UPDATE OF document,owner_id,preparation_id,wallet_address ON imported_swap_signing_intents WHEN json_type(OLD.document,'$.acquisition') IS NOT NULL AND (NEW.document<>OLD.document OR NEW.owner_id<>OLD.owner_id OR NEW.preparation_id<>OLD.preparation_id OR NEW.wallet_address<>OLD.wallet_address) BEGIN SELECT RAISE(ABORT,'Approved acquisition is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER imported_acquisition_preparation_immutable BEFORE UPDATE ON imported_swap_preparations WHEN EXISTS(SELECT 1 FROM imported_swap_signing_intents WHERE owner_id=OLD.owner_id AND preparation_id=OLD.id AND json_type(document,'$.acquisition') IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Approved acquisition preparation is immutable'); END;
