CREATE TABLE imported_trade_sessions(owner_id TEXT NOT NULL,id TEXT NOT NULL,project_id TEXT NOT NULL,document TEXT NOT NULL CHECK(json_valid(document) AND length(document)<=16384),state TEXT NOT NULL CHECK(state IN ('active','cancelled')),revision INTEGER NOT NULL CHECK(revision>0),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_id,id));
--> statement-breakpoint
CREATE INDEX imported_trade_sessions_project ON imported_trade_sessions(owner_id,project_id,created_at);
--> statement-breakpoint
CREATE TRIGGER trade_session_capacity BEFORE INSERT ON imported_trade_sessions WHEN NOT EXISTS(SELECT 1 FROM imported_trade_sessions WHERE owner_id=NEW.owner_id AND id=NEW.id) AND (SELECT COUNT(*) FROM imported_trade_sessions WHERE owner_id=NEW.owner_id AND project_id=NEW.project_id)>=100 BEGIN SELECT RAISE(ABORT,'Trade session history is full'); END;
--> statement-breakpoint
CREATE TRIGGER trade_session_immutable BEFORE UPDATE ON imported_trade_sessions WHEN NEW.owner_id<>OLD.owner_id OR NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.document<>OLD.document OR NEW.created_at<>OLD.created_at OR OLD.state<>'active' OR NEW.state<>'cancelled' OR NEW.revision<>OLD.revision+1 BEGIN SELECT RAISE(ABORT,'Trade session terms and lifecycle are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER trade_session_busy BEFORE UPDATE ON imported_trade_sessions WHEN EXISTS(SELECT 1 FROM imported_swap_signing_intents i JOIN imported_swap_preparations p ON p.owner_id=i.owner_id AND p.id=i.preparation_id WHERE i.owner_id=OLD.owner_id AND json_extract(p.document,'$.session.sessionId')=OLD.id AND i.state IN ('awaiting_signature','signed','submitted')) BEGIN SELECT RAISE(ABORT,'Trade session has a live approval'); END;
--> statement-breakpoint
CREATE TRIGGER trade_session_keep BEFORE DELETE ON imported_trade_sessions BEGIN SELECT RAISE(ABORT,'Trade session history is retained'); END;
--> statement-breakpoint
CREATE TRIGGER trade_session_duplicate BEFORE INSERT ON imported_swap_signing_intents WHEN json_type(NEW.document,'$.session') IS NOT NULL OR EXISTS(SELECT 1 FROM imported_swap_preparations WHERE owner_id=NEW.owner_id AND id=NEW.preparation_id AND json_type(document,'$.session') IS NOT NULL) BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM imported_swap_signing_intents WHERE id=NEW.id OR (owner_id=NEW.owner_id AND preparation_id=NEW.preparation_id)) THEN RAISE(ABORT,'Trade session approval already exists') END; END;
--> statement-breakpoint
CREATE TRIGGER trade_session_approval AFTER INSERT ON imported_swap_signing_intents WHEN json_type(NEW.document,'$.session') IS NOT NULL OR EXISTS(SELECT 1 FROM imported_swap_preparations WHERE owner_id=NEW.owner_id AND id=NEW.preparation_id AND json_type(document,'$.session') IS NOT NULL) BEGIN
 SELECT CASE WHEN NEW.state<>'awaiting_signature' OR NOT EXISTS(
 SELECT 1 FROM imported_swap_preparations p JOIN imported_trade_sessions t ON t.owner_id=p.owner_id AND t.id=json_extract(p.document,'$.session.sessionId') AND t.project_id=p.project_id
 JOIN json_each(t.document,'$.entries') e ON json_extract(e.value,'$.entry')=json_extract(NEW.document,'$.session.entry')
 JOIN imported_token_projects q ON q.owner_id=p.owner_id AND q.id=p.project_id AND q.revision=p.project_revision AND q.archived=0 AND q.chain='Solana'
 JOIN workspace_wallets w ON w.owner_id=p.owner_id AND w.chain='Solana' AND w.address=p.wallet_address AND w.revision=p.wallet_revision AND w.archived=0
 WHERE p.owner_id=NEW.owner_id AND p.id=NEW.preparation_id AND p.wallet_address=NEW.wallet_address AND t.state='active' AND t.revision=json_extract(NEW.document,'$.session.sessionRevision')
 AND json_extract(NEW.document,'$.session')=json_extract(p.document,'$.session') AND json_extract(NEW.document,'$.session.format')='trade-session-entry-v1'
 AND length(json_extract(NEW.document,'$.session.termsSha256'))=64 AND json_extract(NEW.document,'$.session.termsSha256') NOT GLOB '*[^0-9a-f]*'
 AND json_extract(t.document,'$.projectRevision')=p.project_revision AND json_extract(t.document,'$.mint')=q.address
 AND json_extract(t.document,'$.decimals')=json_extract(q.document,'$.token.decimals') AND json_extract(t.document,'$.side')=json_extract(p.document,'$.side')
 AND json_extract(e.value,'$.wallet')=p.wallet_address AND json_extract(e.value,'$.walletRevision')=p.wallet_revision
 AND json_extract(e.value,'$.unitsRaw')=json_extract(p.document,'$.inAmountRaw') AND json_extract(NEW.document,'$.inputRaw')=json_extract(e.value,'$.unitsRaw') AND json_extract(NEW.document,'$.session.unitsRaw')=json_extract(NEW.document,'$.inputRaw')
 AND json_extract(NEW.document,'$.sha256')=json_extract(p.document,'$.transaction.sha256') AND json_extract(NEW.document,'$.minimumOutputRaw')=json_extract(p.document,'$.minimumOutRaw')
 AND json_extract(NEW.document,'$.inputMint')=json_extract(p.document,'$.inputMint') AND json_extract(NEW.document,'$.outputMint')=json_extract(p.document,'$.outputMint')
 AND json_extract(NEW.document,'$.wallet')=NEW.wallet_address AND json_extract(NEW.document,'$.preparationId')=p.id
 ) THEN RAISE(ABORT,'Trade session approval context differs') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM imported_swap_signing_intents i JOIN imported_swap_preparations p ON p.owner_id=i.owner_id AND p.id=i.preparation_id WHERE i.owner_id=NEW.owner_id AND i.id<>NEW.id AND json_extract(p.document,'$.session.sessionId')=json_extract(NEW.document,'$.session.sessionId') AND json_extract(p.document,'$.session.entry')=json_extract(NEW.document,'$.session.entry') AND i.state IN ('awaiting_signature','signed','submitted','finalized')) THEN RAISE(ABORT,'Trade session entry already approved or filled') END;
END;
--> statement-breakpoint
CREATE TRIGGER trade_session_preparation_keep_update BEFORE UPDATE ON imported_swap_preparations WHEN EXISTS(SELECT 1 FROM imported_swap_signing_intents WHERE owner_id=OLD.owner_id AND preparation_id=OLD.id AND json_type(document,'$.session') IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Approved session preparation is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER trade_session_preparation_keep_delete BEFORE DELETE ON imported_swap_preparations WHEN EXISTS(SELECT 1 FROM imported_swap_signing_intents WHERE owner_id=OLD.owner_id AND preparation_id=OLD.id AND json_type(document,'$.session') IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Approved session preparation is retained'); END;
--> statement-breakpoint
CREATE TRIGGER trade_session_intent_keep BEFORE DELETE ON imported_swap_signing_intents WHEN json_type(OLD.document,'$.session') IS NOT NULL BEGIN SELECT RAISE(ABORT,'Session approval history is retained'); END;
--> statement-breakpoint
CREATE TRIGGER trade_session_intent_transition BEFORE UPDATE OF state ON imported_swap_signing_intents WHEN json_type(OLD.document,'$.session') IS NOT NULL AND OLD.state<>NEW.state BEGIN
 SELECT CASE WHEN NOT ((OLD.state='awaiting_signature' AND NEW.state IN ('signed','cancelled')) OR (OLD.state='signed' AND NEW.state IN ('submitted','finalized','failed')) OR (OLD.state='submitted' AND NEW.state IN ('finalized','failed'))) THEN RAISE(ABORT,'Invalid trade session approval transition') END;
 SELECT CASE WHEN NEW.state='finalized' AND NOT EXISTS(SELECT 1 FROM imported_swap_receipts r JOIN imported_swap_preparations p ON p.owner_id=r.owner_id AND p.id=r.preparation_id WHERE r.owner_id=NEW.owner_id AND r.intent_id=NEW.id AND r.preparation_id=NEW.preparation_id AND r.project_id=p.project_id AND r.project_revision=p.project_revision AND r.wallet_revision=p.wallet_revision AND r.signature=NEW.signature AND json_extract(r.document,'$.signature')=NEW.signature AND json_extract(r.document,'$.network')='mainnet' AND json_extract(r.document,'$.commitment')='finalized' AND json_extract(r.document,'$.signatureVerified')=1 AND json_extract(r.document,'$.preparationSha256')=json_extract(NEW.document,'$.sha256') AND json_extract(r.document,'$.wallet')=NEW.wallet_address AND json_extract(r.document,'$.side')=json_extract(p.document,'$.side') AND json_extract(r.document,'$.mint')= CASE json_extract(p.document,'$.side') WHEN 'Buy' THEN json_extract(NEW.document,'$.outputMint') ELSE json_extract(NEW.document,'$.inputMint') END AND (json_extract(p.document,'$.side')='Buy' OR json_extract(r.document,'$.tokenUnitsRaw')=json_extract(NEW.document,'$.inputRaw'))) THEN RAISE(ABORT,'Trade session finalization lacks its exact receipt') END;
END;
--> statement-breakpoint
CREATE TRIGGER trade_session_receipt_keep_update BEFORE UPDATE ON imported_swap_receipts WHEN EXISTS(SELECT 1 FROM imported_swap_signing_intents WHERE owner_id=OLD.owner_id AND id=OLD.intent_id AND json_type(document,'$.session') IS NOT NULL AND state='finalized') BEGIN SELECT RAISE(ABORT,'Finalized session receipt is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER trade_session_receipt_keep_delete BEFORE DELETE ON imported_swap_receipts WHEN EXISTS(SELECT 1 FROM imported_swap_signing_intents WHERE owner_id=OLD.owner_id AND id=OLD.intent_id AND json_type(document,'$.session') IS NOT NULL AND state='finalized') BEGIN SELECT RAISE(ABORT,'Finalized session receipt is retained'); END;
