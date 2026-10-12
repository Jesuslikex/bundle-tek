-- Atomic approved multi-acquisition allocations. Decimal column sums remain exact beyond signed SQLite integers.
DROP INDEX imported_trade_lot_links_sell;
--> statement-breakpoint
CREATE UNIQUE INDEX imported_trade_lot_links_sell ON imported_trade_lot_links(owner_id,sell_receipt_id,buy_receipt_id);
--> statement-breakpoint
DROP TRIGGER imported_trade_lot_links_context;
--> statement-breakpoint
CREATE TRIGGER imported_trade_lot_links_context BEFORE INSERT ON imported_trade_lot_links WHEN NOT EXISTS(
 SELECT 1 FROM imported_swap_receipts b JOIN imported_swap_receipts s ON s.owner_id=b.owner_id AND s.project_id=b.project_id
 WHERE b.owner_id=NEW.owner_id AND b.project_id=NEW.project_id AND b.id=NEW.buy_receipt_id AND s.id=NEW.sell_receipt_id
 AND json_extract(b.document,'$.side')='Buy' AND json_extract(s.document,'$.side')='Sell'
 AND json_extract(b.document,'$.signatureVerified')=1 AND json_extract(s.document,'$.signatureVerified')=1
 AND json_extract(b.document,'$.network')='mainnet' AND json_extract(s.document,'$.network')='mainnet'
 AND json_extract(b.document,'$.commitment')='finalized' AND json_extract(s.document,'$.commitment')='finalized'
 AND json_extract(b.document,'$.wallet')=json_extract(s.document,'$.wallet')
 AND json_extract(b.document,'$.mint')=json_extract(s.document,'$.mint')
 AND json_extract(b.document,'$.decimals')=json_extract(s.document,'$.decimals')
 AND json_extract(b.document,'$.slot')<json_extract(s.document,'$.slot')
 AND (length(NEW.units_raw)<length(json_extract(s.document,'$.tokenUnitsRaw')) OR (length(NEW.units_raw)=length(json_extract(s.document,'$.tokenUnitsRaw')) AND NEW.units_raw<=json_extract(s.document,'$.tokenUnitsRaw')))
 AND json_extract(b.document,'$.signature')=NEW.buy_signature AND json_extract(s.document,'$.signature')=NEW.sell_signature
 AND json_extract(b.document,'$.preparationSha256')=NEW.buy_preparation_sha256 AND json_extract(s.document,'$.preparationSha256')=NEW.sell_preparation_sha256
) BEGIN SELECT RAISE(ABORT,'Acquisition link context differs'); END;
--> statement-breakpoint
CREATE TRIGGER imported_acquisition_partial_context BEFORE INSERT ON imported_trade_lot_links WHEN NEW.units_raw<>(SELECT json_extract(document,'$.tokenUnitsRaw') FROM imported_swap_receipts WHERE owner_id=NEW.owner_id AND id=NEW.sell_receipt_id) AND NOT EXISTS(SELECT 1 FROM imported_swap_signing_intents i JOIN imported_swap_preparations p ON p.owner_id=i.owner_id AND p.id=i.preparation_id JOIN imported_swap_receipts s ON s.owner_id=i.owner_id AND s.intent_id=i.id
 WHERE i.owner_id=NEW.owner_id AND i.state IN ('signed','submitted') AND p.project_id=NEW.project_id AND s.id=NEW.sell_receipt_id AND i.signature=NEW.sell_signature
 AND json_extract(i.document,'$.acquisition')=json_extract(p.document,'$.acquisition')
 AND ((json_type(i.document,'$.acquisition.kind') IS NULL AND json_extract(i.document,'$.acquisition.buyReceiptId')=NEW.buy_receipt_id AND json_extract(i.document,'$.acquisition.unitsRaw')=NEW.units_raw) OR (json_extract(i.document,'$.acquisition.kind')='basket' AND EXISTS(SELECT 1 FROM json_each(i.document,'$.acquisition.allocations') a WHERE json_extract(a.value,'$.buyReceiptId')=NEW.buy_receipt_id AND json_extract(a.value,'$.unitsRaw')=NEW.units_raw AND json_extract(a.value,'$.buySignature')=NEW.buy_signature AND json_extract(a.value,'$.buyPreparationSha256')=NEW.buy_preparation_sha256)))) BEGIN SELECT RAISE(ABORT,'Partial acquisition requires its registered approval'); END;
--> statement-breakpoint
DROP TRIGGER imported_acquisition_busy_wallet;
--> statement-breakpoint
CREATE TRIGGER imported_acquisition_busy_wallet BEFORE INSERT ON imported_trade_lot_links WHEN EXISTS(SELECT 1 FROM solana_execution_reservations WHERE owner_id=NEW.owner_id AND wallet_address=(SELECT json_extract(document,'$.wallet') FROM imported_swap_receipts WHERE owner_id=NEW.owner_id AND id=NEW.buy_receipt_id)) AND NOT EXISTS(SELECT 1 FROM imported_swap_signing_intents i JOIN imported_swap_preparations p ON p.owner_id=i.owner_id AND p.id=i.preparation_id JOIN imported_swap_receipts s ON s.owner_id=i.owner_id AND s.intent_id=i.id
 WHERE i.owner_id=NEW.owner_id AND i.state IN ('signed','submitted') AND p.project_id=NEW.project_id AND s.id=NEW.sell_receipt_id AND i.signature=NEW.sell_signature
 AND json_extract(i.document,'$.acquisition')=json_extract(p.document,'$.acquisition')
 AND ((json_type(i.document,'$.acquisition.kind') IS NULL AND json_extract(i.document,'$.acquisition.buyReceiptId')=NEW.buy_receipt_id AND json_extract(i.document,'$.acquisition.unitsRaw')=NEW.units_raw) OR (json_extract(i.document,'$.acquisition.kind')='basket' AND EXISTS(SELECT 1 FROM json_each(i.document,'$.acquisition.allocations') a WHERE json_extract(a.value,'$.buyReceiptId')=NEW.buy_receipt_id AND json_extract(a.value,'$.unitsRaw')=NEW.units_raw AND json_extract(a.value,'$.buySignature')=NEW.buy_signature AND json_extract(a.value,'$.buyPreparationSha256')=NEW.buy_preparation_sha256)))) BEGIN SELECT RAISE(ABORT,'Wallet approval holds acquisition accounting'); END;
--> statement-breakpoint
DROP TRIGGER imported_acquisition_approval_context;
--> statement-breakpoint
CREATE TRIGGER imported_acquisition_approval_context BEFORE INSERT ON imported_swap_signing_intents WHEN EXISTS(SELECT 1 FROM imported_swap_preparations WHERE owner_id=NEW.owner_id AND id=NEW.preparation_id AND json_type(document,'$.acquisition') IS NOT NULL) OR json_type(NEW.document,'$.acquisition') IS NOT NULL BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM imported_swap_preparations p JOIN imported_swap_receipts b ON b.owner_id=p.owner_id AND b.project_id=p.project_id AND b.id=json_extract(p.document,'$.acquisition.buyReceiptId') WHERE p.owner_id=NEW.owner_id AND p.id=NEW.preparation_id AND json_type(p.document,'$.acquisition.kind') IS NULL AND json_extract(p.document,'$.side')='Sell' AND json_extract(p.document,'$.acquisition')=json_extract(NEW.document,'$.acquisition') AND json_extract(NEW.document,'$.inputRaw')=json_extract(p.document,'$.acquisition.unitsRaw') AND NEW.wallet_address=json_extract(b.document,'$.wallet') AND p.project_id=json_extract(p.document,'$.acquisition.projectId') AND json_extract(b.document,'$.side')='Buy' AND json_extract(b.document,'$.mint')=json_extract(p.document,'$.inputMint') AND json_extract(b.document,'$.signature')=json_extract(p.document,'$.acquisition.buySignature') AND json_extract(b.document,'$.preparationSha256')=json_extract(p.document,'$.acquisition.buyPreparationSha256') AND COALESCE((SELECT revision FROM imported_trade_lot_gates WHERE owner_id=NEW.owner_id AND project_id=p.project_id),0)=json_extract(p.document,'$.acquisition.linkRevision')) AND NOT EXISTS(SELECT 1 FROM imported_swap_preparations p WHERE p.owner_id=NEW.owner_id AND p.id=NEW.preparation_id AND json_extract(p.document,'$.side')='Sell'
 AND json_extract(p.document,'$.acquisition')=json_extract(NEW.document,'$.acquisition') AND json_extract(NEW.document,'$.acquisition.kind')='basket' AND json_extract(NEW.document,'$.acquisition.version')=1
 AND json_type(NEW.document,'$.acquisition.allocations')='array' AND json_array_length(NEW.document,'$.acquisition.allocations') BETWEEN 2 AND 8
 AND p.project_id=json_extract(NEW.document,'$.acquisition.projectId') AND NEW.wallet_address=json_extract(NEW.document,'$.acquisition.wallet')
 AND json_extract(NEW.document,'$.inputMint')=json_extract(NEW.document,'$.acquisition.mint') AND json_extract(p.document,'$.inputMint')=json_extract(NEW.document,'$.inputMint')
 AND json_extract(NEW.document,'$.inputRaw')=json_extract(NEW.document,'$.acquisition.unitsRaw') AND json_extract(p.document,'$.inAmountRaw')=json_extract(NEW.document,'$.inputRaw')
 AND json_type(NEW.document,'$.acquisition.unitsRaw')='text' AND length(json_extract(NEW.document,'$.acquisition.unitsRaw')) BETWEEN 1 AND 20
 AND json_extract(NEW.document,'$.acquisition.unitsRaw') GLOB '[1-9]*' AND json_extract(NEW.document,'$.acquisition.unitsRaw') NOT GLOB '*[^0-9]*'
 AND (length(json_extract(NEW.document,'$.acquisition.unitsRaw'))<20 OR json_extract(NEW.document,'$.acquisition.unitsRaw')<='18446744073709551615')
 AND COALESCE((SELECT revision FROM imported_trade_lot_gates WHERE owner_id=NEW.owner_id AND project_id=p.project_id),0)=json_extract(NEW.document,'$.acquisition.linkRevision')
 AND (SELECT COUNT(DISTINCT json_extract(value,'$.buyReceiptId')) FROM json_each(NEW.document,'$.acquisition.allocations'))=json_array_length(NEW.document,'$.acquisition.allocations')
) THEN RAISE(ABORT,'Reviewed acquisition context differs') END; END;
--> statement-breakpoint
CREATE TRIGGER imported_acquisition_basket_sources BEFORE INSERT ON imported_swap_signing_intents WHEN json_extract(NEW.document,'$.acquisition.kind')='basket' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.document,'$.acquisition.allocations') a WHERE NOT EXISTS(
 SELECT 1 FROM imported_swap_receipts b WHERE b.owner_id=NEW.owner_id AND b.project_id=json_extract(NEW.document,'$.acquisition.projectId') AND b.id=json_extract(a.value,'$.buyReceiptId') AND json_extract(b.document,'$.side')='Buy'
 AND json_extract(a.value,'$.projectId')=json_extract(NEW.document,'$.acquisition.projectId') AND json_extract(a.value,'$.wallet')=NEW.wallet_address AND json_extract(b.document,'$.wallet')=NEW.wallet_address
 AND json_extract(a.value,'$.mint')=json_extract(NEW.document,'$.inputMint') AND json_extract(b.document,'$.mint')=json_extract(a.value,'$.mint')
 AND json_extract(b.document,'$.decimals')=json_extract(a.value,'$.decimals') AND json_extract(a.value,'$.decimals')=json_extract(NEW.document,'$.acquisition.decimals')
 AND json_extract(b.document,'$.tokenUnitsRaw')=json_extract(a.value,'$.acquiredRaw') AND json_extract(b.document,'$.signature')=json_extract(a.value,'$.buySignature') AND json_extract(b.document,'$.preparationSha256')=json_extract(a.value,'$.buyPreparationSha256')
 AND json_extract(a.value,'$.linkRevision')=json_extract(NEW.document,'$.acquisition.linkRevision')
 AND json_type(a.value,'$.unitsRaw')='text' AND length(json_extract(a.value,'$.unitsRaw')) BETWEEN 1 AND 20 AND json_extract(a.value,'$.unitsRaw') GLOB '[1-9]*' AND json_extract(a.value,'$.unitsRaw') NOT GLOB '*[^0-9]*' AND (length(json_extract(a.value,'$.unitsRaw'))<20 OR json_extract(a.value,'$.unitsRaw')<='18446744073709551615')
 )) THEN RAISE(ABORT,'Reviewed acquisition sources differ') END;
END;
--> statement-breakpoint
CREATE TRIGGER imported_acquisition_basket_total BEFORE INSERT ON imported_swap_signing_intents WHEN json_extract(NEW.document,'$.acquisition.kind')='basket' BEGIN
 SELECT CASE WHEN NOT EXISTS(WITH RECURSIVE digits(pos,carry,bad) AS (SELECT 1,0,0 UNION ALL SELECT pos+1,(carry+(SELECT COALESCE(SUM(CAST(substr('00000000000000000000'||json_extract(value,'$.unitsRaw'),-pos,1) AS INTEGER)),0) FROM json_each(NEW.document,'$.acquisition.allocations')))/10,bad OR ((carry+(SELECT COALESCE(SUM(CAST(substr('00000000000000000000'||json_extract(value,'$.unitsRaw'),-pos,1) AS INTEGER)),0) FROM json_each(NEW.document,'$.acquisition.allocations')))%10<>CAST(substr('00000000000000000000'||json_extract(NEW.document,'$.acquisition.unitsRaw'),-pos,1) AS INTEGER)) FROM digits WHERE pos<=20) SELECT 1 FROM digits WHERE pos=21 AND carry=0 AND bad=0) THEN RAISE(ABORT,'Reviewed acquisition total differs') END;
END;
--> statement-breakpoint
DROP TRIGGER imported_acquisition_reserved_receipt_update;
--> statement-breakpoint
CREATE TRIGGER imported_acquisition_reserved_receipt_update BEFORE UPDATE ON imported_swap_receipts WHEN EXISTS(SELECT 1 FROM imported_swap_signing_intents i WHERE i.owner_id=OLD.owner_id AND i.state IN ('awaiting_signature','signed','submitted') AND (json_extract(i.document,'$.acquisition.buyReceiptId')=OLD.id OR EXISTS(SELECT 1 FROM json_each(i.document,'$.acquisition.allocations') a WHERE json_extract(a.value,'$.buyReceiptId')=OLD.id))) BEGIN SELECT RAISE(ABORT,'Approved acquisition evidence is immutable'); END;
--> statement-breakpoint
DROP TRIGGER imported_acquisition_reserved_receipt_delete;
--> statement-breakpoint
CREATE TRIGGER imported_acquisition_reserved_receipt_delete BEFORE DELETE ON imported_swap_receipts WHEN EXISTS(SELECT 1 FROM imported_swap_signing_intents i WHERE i.owner_id=OLD.owner_id AND i.state IN ('awaiting_signature','signed','submitted') AND (json_extract(i.document,'$.acquisition.buyReceiptId')=OLD.id OR EXISTS(SELECT 1 FROM json_each(i.document,'$.acquisition.allocations') a WHERE json_extract(a.value,'$.buyReceiptId')=OLD.id))) BEGIN SELECT RAISE(ABORT,'Approved acquisition evidence is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER imported_acquisition_finalize_complete BEFORE UPDATE OF state ON imported_swap_signing_intents WHEN NEW.state='finalized' AND OLD.state<>'finalized' AND json_extract(NEW.document,'$.acquisition.kind')='basket' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM imported_swap_receipts s WHERE s.owner_id=NEW.owner_id AND s.intent_id=NEW.id AND json_extract(s.document,'$.signature')=NEW.signature AND json_extract(s.document,'$.tokenUnitsRaw')=json_extract(NEW.document,'$.inputRaw') AND (SELECT COUNT(*) FROM imported_trade_lot_links l WHERE l.owner_id=NEW.owner_id AND l.sell_receipt_id=s.id)=json_array_length(NEW.document,'$.acquisition.allocations') AND NOT EXISTS(SELECT 1 FROM json_each(NEW.document,'$.acquisition.allocations') a WHERE NOT EXISTS(SELECT 1 FROM imported_trade_lot_links l WHERE l.owner_id=NEW.owner_id AND l.project_id=s.project_id AND l.sell_receipt_id=s.id AND l.buy_receipt_id=json_extract(a.value,'$.buyReceiptId') AND l.units_raw=json_extract(a.value,'$.unitsRaw') AND l.buy_signature=json_extract(a.value,'$.buySignature') AND l.buy_preparation_sha256=json_extract(a.value,'$.buyPreparationSha256') AND l.sell_signature=NEW.signature AND l.sell_preparation_sha256=json_extract(NEW.document,'$.sha256')))) THEN RAISE(ABORT,'Finalized acquisition allocations are incomplete') END;
END;
--> statement-breakpoint
DROP TRIGGER imported_swap_signing_event_insert;
--> statement-breakpoint
DROP TRIGGER imported_swap_signing_event_transition;
--> statement-breakpoint
DROP TRIGGER imported_swap_failure_recovery;
--> statement-breakpoint
CREATE TABLE imported_swap_signing_events_v2 (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, intent_id TEXT NOT NULL, preparation_id TEXT NOT NULL,
 project_id TEXT NOT NULL, project_revision INTEGER NOT NULL CHECK(project_revision>0), wallet_revision INTEGER NOT NULL CHECK(wallet_revision>0),
 wallet_address TEXT NOT NULL,
 type TEXT NOT NULL CHECK(type IN ('approval.baseline','approval.reviewed','approval.signed','approval.submission_started','approval.finalized','approval.failed','approval.cancelled')),
 state TEXT NOT NULL CHECK(state IN ('awaiting_signature','signed','submitted','finalized','failed','cancelled')),
 signature TEXT, document TEXT NOT NULL CHECK(json_valid(document) AND length(document)<=16384), created_at TEXT NOT NULL, failure_receipt TEXT CHECK(failure_receipt IS NULL OR (state='failed' AND json_valid(failure_receipt) AND length(failure_receipt)<=4096))
);
--> statement-breakpoint
INSERT INTO imported_swap_signing_events_v2(sequence,id,owner_id,intent_id,preparation_id,project_id,project_revision,wallet_revision,wallet_address,type,state,signature,document,created_at,failure_receipt) SELECT sequence,id,owner_id,intent_id,preparation_id,project_id,project_revision,wallet_revision,wallet_address,type,state,signature,document,created_at,failure_receipt FROM imported_swap_signing_events;
--> statement-breakpoint
DROP TABLE imported_swap_signing_events;
--> statement-breakpoint
ALTER TABLE imported_swap_signing_events_v2 RENAME TO imported_swap_signing_events;
--> statement-breakpoint
CREATE INDEX imported_swap_signing_events_owner ON imported_swap_signing_events(owner_id,created_at,sequence);
--> statement-breakpoint
CREATE INDEX imported_swap_signing_events_project ON imported_swap_signing_events(owner_id,project_id,created_at,sequence);
--> statement-breakpoint
CREATE INDEX imported_swap_signing_events_intent ON imported_swap_signing_events(owner_id,intent_id,sequence);
--> statement-breakpoint
CREATE TRIGGER imported_swap_signing_events_immutable_update BEFORE UPDATE ON imported_swap_signing_events BEGIN SELECT RAISE(ABORT,'Imported signing event is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER imported_swap_signing_events_immutable_delete BEFORE DELETE ON imported_swap_signing_events BEGIN SELECT RAISE(ABORT,'Imported signing event is immutable'); END;
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
CREATE TRIGGER imported_swap_signing_event_transition AFTER UPDATE OF state ON imported_swap_signing_intents WHEN OLD.state<>NEW.state BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM imported_swap_preparations s WHERE s.owner_id=NEW.owner_id AND s.id=NEW.preparation_id AND s.wallet_address=NEW.wallet_address) THEN RAISE(ABORT,'Imported signing history context unavailable') END;
 INSERT INTO imported_swap_signing_events(id,owner_id,intent_id,preparation_id,project_id,project_revision,wallet_revision,wallet_address,type,state,signature,document,created_at,failure_receipt)
 SELECT lower(hex(randomblob(16))),NEW.owner_id,NEW.id,NEW.preparation_id,s.project_id,s.project_revision,s.wallet_revision,NEW.wallet_address,
 CASE NEW.state WHEN 'signed' THEN 'approval.signed' WHEN 'submitted' THEN 'approval.submission_started' WHEN 'finalized' THEN 'approval.finalized' WHEN 'failed' THEN 'approval.failed' WHEN 'cancelled' THEN 'approval.cancelled' ELSE 'approval.reviewed' END,
 NEW.state,NEW.signature,
 json_object('side',json_extract(s.document,'$.side'),'sha256',json_extract(NEW.document,'$.sha256'),'inputMint',json_extract(NEW.document,'$.inputMint'),'outputMint',json_extract(NEW.document,'$.outputMint'),'inputRaw',json_extract(NEW.document,'$.inputRaw'),'minimumOutputRaw',json_extract(NEW.document,'$.minimumOutputRaw'),'acquisition',json_extract(NEW.document,'$.acquisition')),
 NEW.updated_at,NEW.failure_receipt FROM imported_swap_preparations s WHERE s.owner_id=NEW.owner_id AND s.id=NEW.preparation_id;
END;
--> statement-breakpoint
CREATE TRIGGER imported_swap_failure_recovery AFTER UPDATE OF failure_receipt ON imported_swap_signing_intents WHEN OLD.state='failed' AND NEW.state='failed' AND OLD.failure_receipt IS NULL AND NEW.failure_receipt IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM imported_swap_preparations s WHERE s.owner_id=NEW.owner_id AND s.id=NEW.preparation_id AND s.wallet_address=NEW.wallet_address) THEN RAISE(ABORT,'Imported signing history context unavailable') END;
 INSERT INTO imported_swap_signing_events(id,owner_id,intent_id,preparation_id,project_id,project_revision,wallet_revision,wallet_address,type,state,signature,document,created_at,failure_receipt)
 SELECT lower(hex(randomblob(16))),NEW.owner_id,NEW.id,NEW.preparation_id,s.project_id,s.project_revision,s.wallet_revision,NEW.wallet_address,
 CASE NEW.state WHEN 'signed' THEN 'approval.signed' WHEN 'submitted' THEN 'approval.submission_started' WHEN 'finalized' THEN 'approval.finalized' WHEN 'failed' THEN 'approval.failed' WHEN 'cancelled' THEN 'approval.cancelled' ELSE 'approval.reviewed' END,
 NEW.state,NEW.signature,
 json_object('side',json_extract(s.document,'$.side'),'sha256',json_extract(NEW.document,'$.sha256'),'inputMint',json_extract(NEW.document,'$.inputMint'),'outputMint',json_extract(NEW.document,'$.outputMint'),'inputRaw',json_extract(NEW.document,'$.inputRaw'),'minimumOutputRaw',json_extract(NEW.document,'$.minimumOutputRaw'),'acquisition',json_extract(NEW.document,'$.acquisition')),
 NEW.updated_at,NEW.failure_receipt FROM imported_swap_preparations s WHERE s.owner_id=NEW.owner_id AND s.id=NEW.preparation_id;
END;
