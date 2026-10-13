DROP TRIGGER conditional_approval_reserve;
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
 AND json_extract(p.document,'$.side') IN ('Buy','Sell') AND json_extract(NEW.document,'$.inputMint')= CASE json_extract(p.document,'$.side') WHEN 'Buy' THEN 'So11111111111111111111111111111111111111112' ELSE q.address END
 AND json_extract(p.document,'$.inputMint')=json_extract(NEW.document,'$.inputMint') AND json_extract(o.document,'$.mint')=q.address
 AND json_extract(o.document,'$.decimals')=json_extract(q.document,'$.token.decimals')
 AND json_extract(NEW.document,'$.outputMint')= CASE json_extract(p.document,'$.side') WHEN 'Buy' THEN q.address ELSE 'So11111111111111111111111111111111111111112' END
 AND json_extract(NEW.document,'$.sha256')=json_extract(p.document,'$.transaction.sha256')
 AND json_extract(NEW.document,'$.conditional')=json_extract(p.document,'$.conditional')
 AND ((json_extract(p.document,'$.side')='Sell' AND json_extract(o.document,'$.format')='conditional-sell-v1' AND json_extract(NEW.document,'$.conditional.format')='conditional-preparation-v1') OR (json_extract(p.document,'$.side')='Buy' AND json_extract(o.document,'$.format')='conditional-buy-v1' AND json_extract(o.document,'$.side')='Buy' AND json_extract(o.document,'$.inputMint')='So11111111111111111111111111111111111111112' AND json_extract(o.document,'$.inputDecimals')=9 AND json_extract(NEW.document,'$.conditional.format')='conditional-preparation-v2' AND json_extract(NEW.document,'$.conditional.side')='Buy' AND json_extract(NEW.document,'$.conditional.inputMint')='So11111111111111111111111111111111111111112' AND json_extract(NEW.document,'$.conditional.inputDecimals')=9 AND json_extract(NEW.document,'$.conditional.outputMint')=q.address AND json_extract(NEW.document,'$.conditional.outputDecimals')=json_extract(q.document,'$.token.decimals')))
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
DROP TRIGGER conditional_intent_finalize;
--> statement-breakpoint
CREATE TRIGGER conditional_intent_finalize AFTER UPDATE OF state ON imported_swap_signing_intents WHEN json_type(NEW.document,'$.conditional') IS NOT NULL AND OLD.state<>NEW.state AND NEW.state='finalized' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM imported_swap_receipts r JOIN imported_swap_preparations p ON p.owner_id=r.owner_id AND p.id=r.preparation_id WHERE r.project_id=p.project_id AND r.project_revision=p.project_revision AND r.wallet_revision=p.wallet_revision AND json_extract(r.document,'$.commitment')='finalized' AND json_extract(r.document,'$.network')='mainnet' AND json_extract(r.document,'$.signatureVerified')=1 AND json_extract(r.document,'$.signature')=NEW.signature AND json_extract(r.document,'$.mint')= CASE json_extract(p.document,'$.side') WHEN 'Buy' THEN json_extract(NEW.document,'$.outputMint') ELSE json_extract(NEW.document,'$.inputMint') END AND r.owner_id=NEW.owner_id AND r.intent_id=NEW.id AND r.preparation_id=NEW.preparation_id AND r.signature=NEW.signature AND json_extract(r.document,'$.side')=json_extract(p.document,'$.side') AND json_extract(r.document,'$.wallet')=NEW.wallet_address AND json_extract(r.document,'$.preparationSha256')=json_extract(NEW.document,'$.sha256') AND ((json_extract(p.document,'$.side')='Sell' AND json_extract(r.document,'$.tokenUnitsRaw')=json_extract(NEW.document,'$.inputRaw')) OR (json_extract(p.document,'$.side')='Buy' AND json_extract(r.document,'$.decimals')=json_extract(NEW.document,'$.conditional.outputDecimals') AND json_extract(r.document,'$.quoteUnitsRaw')=json_extract(NEW.document,'$.inputRaw') AND json_extract(r.document,'$.nativeSettlementRaw')='-'||json_extract(NEW.document,'$.inputRaw') AND typeof(json_extract(r.document,'$.tokenUnitsRaw'))='text' AND length(json_extract(r.document,'$.tokenUnitsRaw')) BETWEEN 1 AND 20 AND json_extract(r.document,'$.tokenUnitsRaw') GLOB '[1-9]*' AND json_extract(r.document,'$.tokenUnitsRaw') NOT GLOB '*[^0-9]*' AND (length(json_extract(r.document,'$.tokenUnitsRaw'))<20 OR json_extract(r.document,'$.tokenUnitsRaw')<='18446744073709551615') AND (length(json_extract(r.document,'$.tokenUnitsRaw'))>length(json_extract(NEW.document,'$.minimumOutputRaw')) OR (length(json_extract(r.document,'$.tokenUnitsRaw'))=length(json_extract(NEW.document,'$.minimumOutputRaw')) AND json_extract(r.document,'$.tokenUnitsRaw')>=json_extract(NEW.document,'$.minimumOutputRaw')))))) THEN RAISE(ABORT,'Conditional fill lacks its exact finalized receipt') END;
 INSERT INTO conditional_level_fills(owner_id,order_id,level,intent_id,receipt_id,preparation_id,signature,units_raw,terms_sha256,created_at)
 SELECT NEW.owner_id,json_extract(NEW.document,'$.conditional.orderId'),json_extract(NEW.document,'$.conditional.level'),NEW.id,r.id,NEW.preparation_id,NEW.signature,json_extract(NEW.document,'$.inputRaw'),json_extract(NEW.document,'$.conditional.termsSha256'),NEW.updated_at FROM imported_swap_receipts r WHERE r.owner_id=NEW.owner_id AND r.intent_id=NEW.id AND r.signature=NEW.signature;
END;
--> statement-breakpoint
CREATE TRIGGER conditional_buy_approval_capability BEFORE INSERT ON conditional_sell_orders WHEN json_extract(NEW.document,'$.format')='conditional-buy-v1' BEGIN SELECT CASE WHEN json_extract(NEW.document,'$.side') IS NOT 'Buy' OR json_extract(NEW.document,'$.inputMint') IS NOT 'So11111111111111111111111111111111111111112' OR json_extract(NEW.document,'$.inputDecimals') IS NOT 9 OR json_extract(NEW.document,'$.mint') IS 'So11111111111111111111111111111111111111112' THEN RAISE(ABORT,'Conditional Buy input denomination differs') END; END;
