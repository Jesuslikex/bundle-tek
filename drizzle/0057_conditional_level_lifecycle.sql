CREATE TABLE conditional_level_reservations (
 owner_id TEXT NOT NULL, order_id TEXT NOT NULL, level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 50),
 intent_id TEXT NOT NULL, units_raw TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,order_id,level), UNIQUE(owner_id,intent_id)
);
--> statement-breakpoint
CREATE TABLE conditional_level_fills (
 owner_id TEXT NOT NULL, order_id TEXT NOT NULL, level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 50),
 intent_id TEXT NOT NULL, receipt_id TEXT NOT NULL, preparation_id TEXT NOT NULL,
 signature TEXT NOT NULL, units_raw TEXT NOT NULL, terms_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,order_id,level), UNIQUE(owner_id,intent_id), UNIQUE(owner_id,receipt_id)
);
--> statement-breakpoint
CREATE TRIGGER conditional_order_immutable BEFORE UPDATE ON conditional_sell_orders WHEN
 NEW.owner_id<>OLD.owner_id OR NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.document<>OLD.document OR NEW.created_at<>OLD.created_at
 OR OLD.state<>'draft' OR NEW.state<>'cancelled' OR NEW.revision<>OLD.revision+1
 BEGIN SELECT RAISE(ABORT,'Conditional order terms and lifecycle are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER conditional_order_busy BEFORE UPDATE ON conditional_sell_orders WHEN EXISTS(
 SELECT 1 FROM conditional_level_reservations WHERE owner_id=OLD.owner_id AND order_id=OLD.id
) BEGIN SELECT RAISE(ABORT,'Recover the conditional approval before cancelling its order'); END;
--> statement-breakpoint
CREATE TRIGGER conditional_order_keep BEFORE DELETE ON conditional_sell_orders BEGIN SELECT RAISE(ABORT,'Conditional order history is retained'); END;
--> statement-breakpoint
CREATE TRIGGER conditional_approval_duplicate BEFORE INSERT ON imported_swap_signing_intents WHEN
 json_type(NEW.document,'$.conditional') IS NOT NULL OR EXISTS(SELECT 1 FROM imported_swap_preparations WHERE owner_id=NEW.owner_id AND id=NEW.preparation_id AND json_type(document,'$.conditional') IS NOT NULL)
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM imported_swap_signing_intents WHERE id=NEW.id OR (owner_id=NEW.owner_id AND preparation_id=NEW.preparation_id)) THEN RAISE(ABORT,'Conditional approval already exists') END;
END;
--> statement-breakpoint
CREATE TRIGGER conditional_approval_reserve AFTER INSERT ON imported_swap_signing_intents WHEN
 json_type(NEW.document,'$.conditional') IS NOT NULL OR EXISTS(SELECT 1 FROM imported_swap_preparations WHERE owner_id=NEW.owner_id AND id=NEW.preparation_id AND json_type(document,'$.conditional') IS NOT NULL)
BEGIN
 SELECT CASE WHEN NEW.state<>'awaiting_signature' OR NOT EXISTS(
 SELECT 1 FROM imported_swap_preparations p
 JOIN conditional_sell_orders o ON o.owner_id=p.owner_id AND o.project_id=p.project_id AND o.id=json_extract(p.document,'$.conditional.orderId')
 JOIN imported_token_projects q ON q.owner_id=p.owner_id AND q.id=p.project_id AND q.revision=p.project_revision AND q.archived=0 AND q.chain='Solana'
 JOIN workspace_wallets w ON w.owner_id=p.owner_id AND w.address=p.wallet_address AND w.chain='Solana' AND w.revision=p.wallet_revision AND w.archived=0
 JOIN json_each(o.document,'$.levels') l ON json_extract(l.value,'$.level')=json_extract(NEW.document,'$.conditional.level')
 WHERE p.owner_id=NEW.owner_id AND p.id=NEW.preparation_id AND p.wallet_address=NEW.wallet_address
 AND json_extract(NEW.document,'$.wallet')=NEW.wallet_address AND json_extract(NEW.document,'$.preparationId')=p.id
 AND json_extract(p.document,'$.side')='Sell' AND json_extract(NEW.document,'$.inputMint')=q.address
 AND json_extract(p.document,'$.inputMint')=q.address AND json_extract(o.document,'$.mint')=q.address
 AND json_extract(o.document,'$.decimals')=json_extract(q.document,'$.token.decimals')
 AND json_extract(NEW.document,'$.outputMint')='So11111111111111111111111111111111111111112'
 AND json_extract(NEW.document,'$.sha256')=json_extract(p.document,'$.transaction.sha256')
 AND json_extract(NEW.document,'$.conditional')=json_extract(p.document,'$.conditional')
 AND json_extract(NEW.document,'$.conditional.format')='conditional-preparation-v1'
 AND json_extract(NEW.document,'$.conditional.source')='api.dexscreener.com'
 AND length(json_extract(NEW.document,'$.conditional.termsSha256'))=64 AND json_extract(NEW.document,'$.conditional.termsSha256') NOT GLOB '*[^0-9a-f]*'
 AND o.state='draft' AND o.revision=json_extract(NEW.document,'$.conditional.orderRevision')
 AND json_extract(o.document,'$.projectRevision')=p.project_revision
 AND json_extract(o.document,'$.wallet')=p.wallet_address AND json_extract(o.document,'$.walletRevision')=p.wallet_revision
 AND json_extract(o.document,'$.pair')=json_extract(NEW.document,'$.conditional.pair')
 AND json_extract(o.document,'$.direction')=json_extract(NEW.document,'$.conditional.direction')
 AND json_extract(l.value,'$.targetUsd')=json_extract(NEW.document,'$.conditional.targetUsd')
 AND json_extract(l.value,'$.unitsRaw')=json_extract(NEW.document,'$.inputRaw')
 AND json_extract(NEW.document,'$.minimumOutputRaw')=json_extract(p.document,'$.minimumOutRaw')
 AND json_extract(p.document,'$.inAmountRaw')=json_extract(NEW.document,'$.inputRaw')
 AND json_extract(NEW.document,'$.conditional.unitsRaw')=json_extract(NEW.document,'$.inputRaw')
 AND julianday(json_extract(NEW.document,'$.conditional.expiresAt'))>julianday('now')
 ) THEN RAISE(ABORT,'Conditional approval context differs or expired') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM conditional_level_fills WHERE owner_id=NEW.owner_id AND order_id=json_extract(NEW.document,'$.conditional.orderId') AND level=json_extract(NEW.document,'$.conditional.level')) THEN RAISE(ABORT,'Conditional level already filled') END;
 INSERT INTO conditional_level_reservations VALUES(NEW.owner_id,json_extract(NEW.document,'$.conditional.orderId'),json_extract(NEW.document,'$.conditional.level'),NEW.id,json_extract(NEW.document,'$.inputRaw'),NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER conditional_reservation_context BEFORE INSERT ON conditional_level_reservations WHEN NOT EXISTS(
 SELECT 1 FROM imported_swap_signing_intents i WHERE i.owner_id=NEW.owner_id AND i.id=NEW.intent_id AND i.state='awaiting_signature'
 AND json_extract(i.document,'$.conditional.orderId')=NEW.order_id AND json_extract(i.document,'$.conditional.level')=NEW.level AND json_extract(i.document,'$.inputRaw')=NEW.units_raw
) BEGIN SELECT RAISE(ABORT,'Conditional reservation lacks an approved intent'); END;
--> statement-breakpoint
CREATE TRIGGER conditional_reservation_immutable BEFORE UPDATE ON conditional_level_reservations BEGIN SELECT RAISE(ABORT,'Conditional reservation is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER conditional_reservation_release_guard BEFORE DELETE ON conditional_level_reservations WHEN NOT EXISTS(
 SELECT 1 FROM imported_swap_signing_intents WHERE owner_id=OLD.owner_id AND id=OLD.intent_id AND state IN ('cancelled','failed','finalized')
) BEGIN SELECT RAISE(ABORT,'Live conditional reservation cannot be removed'); END;
--> statement-breakpoint
CREATE TRIGGER conditional_intent_transition BEFORE UPDATE OF state ON imported_swap_signing_intents WHEN json_type(OLD.document,'$.conditional') IS NOT NULL AND OLD.state<>NEW.state BEGIN
 SELECT CASE WHEN NOT ((OLD.state='awaiting_signature' AND NEW.state IN ('signed','cancelled')) OR (OLD.state='signed' AND NEW.state IN ('submitted','finalized','failed')) OR (OLD.state='submitted' AND NEW.state IN ('finalized','failed'))) THEN RAISE(ABORT,'Invalid conditional approval transition') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM conditional_level_reservations WHERE owner_id=OLD.owner_id AND intent_id=OLD.id AND order_id=json_extract(OLD.document,'$.conditional.orderId') AND level=json_extract(OLD.document,'$.conditional.level') AND units_raw=json_extract(OLD.document,'$.inputRaw')) THEN RAISE(ABORT,'Conditional level reservation unavailable') END;
END;
--> statement-breakpoint
CREATE TRIGGER conditional_intent_finalize AFTER UPDATE OF state ON imported_swap_signing_intents WHEN json_type(NEW.document,'$.conditional') IS NOT NULL AND OLD.state<>NEW.state AND NEW.state='finalized' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM imported_swap_receipts r JOIN imported_swap_preparations p ON p.owner_id=r.owner_id AND p.id=r.preparation_id WHERE r.project_id=p.project_id AND r.project_revision=p.project_revision AND r.wallet_revision=p.wallet_revision AND json_extract(r.document,'$.commitment')='finalized' AND json_extract(r.document,'$.network')='mainnet' AND json_extract(r.document,'$.signatureVerified')=1 AND json_extract(r.document,'$.signature')=NEW.signature AND json_extract(r.document,'$.mint')=json_extract(NEW.document,'$.inputMint') AND r.owner_id=NEW.owner_id AND r.intent_id=NEW.id AND r.preparation_id=NEW.preparation_id AND r.signature=NEW.signature AND json_extract(r.document,'$.side')='Sell' AND json_extract(r.document,'$.wallet')=NEW.wallet_address AND json_extract(r.document,'$.preparationSha256')=json_extract(NEW.document,'$.sha256') AND json_extract(r.document,'$.tokenUnitsRaw')=json_extract(NEW.document,'$.inputRaw')) THEN RAISE(ABORT,'Conditional fill lacks its exact finalized receipt') END;
 INSERT INTO conditional_level_fills(owner_id,order_id,level,intent_id,receipt_id,preparation_id,signature,units_raw,terms_sha256,created_at)
 SELECT NEW.owner_id,json_extract(NEW.document,'$.conditional.orderId'),json_extract(NEW.document,'$.conditional.level'),NEW.id,r.id,NEW.preparation_id,NEW.signature,json_extract(NEW.document,'$.inputRaw'),json_extract(NEW.document,'$.conditional.termsSha256'),NEW.updated_at FROM imported_swap_receipts r WHERE r.owner_id=NEW.owner_id AND r.intent_id=NEW.id AND r.signature=NEW.signature;
END;
--> statement-breakpoint
CREATE TRIGGER conditional_intent_release AFTER UPDATE OF state ON imported_swap_signing_intents WHEN json_type(NEW.document,'$.conditional') IS NOT NULL AND OLD.state<>NEW.state AND NEW.state IN ('cancelled','failed','finalized') BEGIN
 -- Trigger order must not matter: finalized rows release only after their fill exists.
 DELETE FROM conditional_level_reservations WHERE owner_id=NEW.owner_id AND intent_id=NEW.id AND (NEW.state<>'finalized' OR EXISTS(SELECT 1 FROM conditional_level_fills WHERE owner_id=NEW.owner_id AND intent_id=NEW.id));
END;
--> statement-breakpoint
CREATE TRIGGER conditional_fill_release AFTER INSERT ON conditional_level_fills BEGIN
 DELETE FROM conditional_level_reservations WHERE owner_id=NEW.owner_id AND intent_id=NEW.intent_id;
END;
--> statement-breakpoint
CREATE TRIGGER conditional_fill_context BEFORE INSERT ON conditional_level_fills WHEN NOT EXISTS(
 SELECT 1 FROM imported_swap_signing_intents i JOIN imported_swap_receipts r ON r.owner_id=i.owner_id AND r.intent_id=i.id JOIN conditional_level_reservations v ON v.owner_id=i.owner_id AND v.intent_id=i.id
 WHERE i.owner_id=NEW.owner_id AND i.id=NEW.intent_id AND i.state='finalized' AND i.preparation_id=NEW.preparation_id
 AND r.id=NEW.receipt_id AND r.signature=NEW.signature AND i.signature=NEW.signature
 AND v.order_id=NEW.order_id AND v.level=NEW.level AND v.units_raw=NEW.units_raw
 AND json_extract(i.document,'$.conditional.termsSha256')=NEW.terms_sha256
) BEGIN SELECT RAISE(ABORT,'Conditional fill context differs'); END;
--> statement-breakpoint
CREATE TRIGGER conditional_fill_keep_update BEFORE UPDATE ON conditional_level_fills BEGIN SELECT RAISE(ABORT,'Conditional fill is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER conditional_fill_keep_delete BEFORE DELETE ON conditional_level_fills BEGIN SELECT RAISE(ABORT,'Conditional fill is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER conditional_preparation_keep_update BEFORE UPDATE ON imported_swap_preparations WHEN EXISTS(SELECT 1 FROM imported_swap_signing_intents WHERE owner_id=OLD.owner_id AND preparation_id=OLD.id AND json_type(document,'$.conditional') IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Approved conditional preparation is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER conditional_preparation_keep_delete BEFORE DELETE ON imported_swap_preparations WHEN EXISTS(SELECT 1 FROM imported_swap_signing_intents WHERE owner_id=OLD.owner_id AND preparation_id=OLD.id AND json_type(document,'$.conditional') IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Approved conditional preparation is retained'); END;
--> statement-breakpoint
CREATE TRIGGER conditional_intent_keep BEFORE DELETE ON imported_swap_signing_intents WHEN json_type(OLD.document,'$.conditional') IS NOT NULL BEGIN SELECT RAISE(ABORT,'Conditional approval history is retained'); END;
--> statement-breakpoint
CREATE TRIGGER conditional_receipt_keep_update BEFORE UPDATE ON imported_swap_receipts WHEN EXISTS(SELECT 1 FROM conditional_level_fills WHERE owner_id=OLD.owner_id AND receipt_id=OLD.id) BEGIN SELECT RAISE(ABORT,'Conditional receipt is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER conditional_receipt_keep_delete BEFORE DELETE ON imported_swap_receipts WHEN EXISTS(SELECT 1 FROM conditional_level_fills WHERE owner_id=OLD.owner_id AND receipt_id=OLD.id) BEGIN SELECT RAISE(ABORT,'Conditional receipt is retained'); END;

