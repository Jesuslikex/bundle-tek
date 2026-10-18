CREATE TABLE launch_sale_allocations (
 owner_id TEXT NOT NULL,
 sale_receipt_id TEXT NOT NULL,
 sale_signature TEXT NOT NULL,
 wallet TEXT NOT NULL,
 mint TEXT NOT NULL,
 document TEXT NOT NULL CHECK(json_valid(document)),
 sha256 TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,sale_receipt_id),
 FOREIGN KEY(owner_id,sale_receipt_id) REFERENCES imported_sale_receipt_evidence(owner_id,receipt_id)
);
--> statement-breakpoint
CREATE INDEX launch_sale_allocations_inventory ON launch_sale_allocations(owner_id,wallet,mint,sale_receipt_id);
--> statement-breakpoint
CREATE UNIQUE INDEX launch_sale_allocations_owner_id_sale_signature_unique ON launch_sale_allocations(owner_id,sale_signature);
--> statement-breakpoint
CREATE TRIGGER launch_sale_allocations_insert BEFORE INSERT ON launch_sale_allocations BEGIN
 SELECT CASE WHEN length(CAST(NEW.document AS BLOB))>16384
 OR length(NEW.sha256)!=64 OR NEW.sha256 GLOB '*[^a-f0-9]*'
 OR julianday(NEW.created_at) IS NULL
 OR json_extract(NEW.document,'$.format') IS NOT 'launch-sale-allocation-v1'
 OR json_extract(NEW.document,'$.policy') IS NOT 'recorded-launch-units-v1'
 OR json_extract(NEW.document,'$.saleReceiptId') IS NOT NEW.sale_receipt_id
 OR json_extract(NEW.document,'$.saleSignature') IS NOT NEW.sale_signature
 OR json_extract(NEW.document,'$.wallet') IS NOT NEW.wallet
 OR json_extract(NEW.document,'$.mint') IS NOT NEW.mint
 OR json_extract(NEW.document,'$.sha256') IS NOT NEW.sha256
 OR json_extract(NEW.document,'$.decimals') IS NOT 6
 OR json_type(NEW.document,'$.executionAllowed') IS NOT 'false'
 OR json_type(NEW.document,'$.signingAllowed') IS NOT 'false'
 OR json_type(NEW.document,'$.profitCalculated') IS NOT 'false'
 OR json_type(NEW.document,'$.acquisitionBasisVerified') IS NOT 'false'
 OR json_type(NEW.document,'$.allocations') IS NOT 'array'
 OR json_array_length(NEW.document,'$.allocations') NOT BETWEEN 1 AND 8
 OR (SELECT count(DISTINCT json_extract(value,'$.originId')) FROM json_each(NEW.document,'$.allocations'))!=json_array_length(NEW.document,'$.allocations')
 THEN RAISE(ABORT,'Invalid launch sale allocation') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM imported_sale_receipt_evidence e
 WHERE e.owner_id=NEW.owner_id AND e.receipt_id=NEW.sale_receipt_id AND e.signature=NEW.sale_signature
 AND json_type(json_extract(e.parent,'$.approvalDocument'),'$.acquisition') IS NULL
 AND e.sha256=json_extract(NEW.document,'$.saleEvidenceSha256')
 AND json_extract(e.evidence,'$.report.wallet')=NEW.wallet AND json_extract(e.evidence,'$.report.mint')=NEW.mint
 AND json_extract(e.evidence,'$.report.decimals')=6
 AND json_extract(e.evidence,'$.report.slot')=json_extract(NEW.document,'$.saleSlot')
 AND json_extract(e.evidence,'$.report.acquiredRaw')=json_extract(NEW.document,'$.soldRaw'))
 THEN RAISE(ABORT,'Retained sale evidence changed') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM imported_trade_lot_links WHERE owner_id=NEW.owner_id AND (sell_receipt_id=NEW.sale_receipt_id OR sell_signature=NEW.sale_signature))
 OR EXISTS(SELECT 1 FROM solana_execution_reservations WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet)
 OR EXISTS(SELECT 1 FROM solana_swap_reservations WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet)
 THEN RAISE(ABORT,'Sale already assigned or wallet approval active') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.document,'$.allocations') a WHERE NOT EXISTS(
 SELECT 1 FROM pump_purchase_cost_sources p
 JOIN pump_purchase_cost_batches b ON b.owner_id=p.owner_id AND b.receipt_id=p.receipt_id
 JOIN pump_group_receipt_evidence e ON e.owner_id=p.owner_id AND e.id=p.receipt_id
 JOIN pump_launch_reviews r ON r.owner_id=p.owner_id AND r.id=p.review_id
 JOIN json_each(e.evidence,'$.report.packets') t ON t.key=json_extract(p.source,'$.packetIndex')
 WHERE p.owner_id=NEW.owner_id AND p.origin_id=json_extract(a.value,'$.originId')
 AND p.sha256=json_extract(a.value,'$.sourceSha256') AND e.sha256=json_extract(a.value,'$.receiptSha256')
 AND p.wallet=NEW.wallet AND p.mint=NEW.mint
 AND json_extract(b.parent,'$.review')=r.review AND json_extract(b.parent,'$.signed')=r.signed
 AND json_extract(b.parent,'$.signature')=r.signature AND json_extract(b.parent,'$.state')=r.state AND json_extract(b.parent,'$.receipt')=r.receipt
 AND json_extract(t.value,'$.slot')=json_extract(a.value,'$.buySlot') AND json_extract(t.value,'$.outcome')='success'
 AND CAST(json_extract(a.value,'$.buySlot') AS INTEGER)<json_extract(NEW.document,'$.saleSlot')
 AND json_extract(a.value,'$.beforeRaw')=COALESCE((SELECT json_extract(x.value,'$.afterRaw') FROM launch_sale_allocations h,json_each(h.document,'$.allocations') x WHERE h.owner_id=NEW.owner_id AND json_extract(x.value,'$.originId')=p.origin_id ORDER BY length(json_extract(x.value,'$.afterRaw')) DESC,json_extract(x.value,'$.afterRaw') DESC LIMIT 1),'0')
 AND (length(json_extract(a.value,'$.afterRaw'))<length(json_extract(p.source,'$.acquiredRaw')) OR (length(json_extract(a.value,'$.afterRaw'))=length(json_extract(p.source,'$.acquiredRaw')) AND json_extract(a.value,'$.afterRaw')<=json_extract(p.source,'$.acquiredRaw')))
 )) THEN RAISE(ABORT,'Launch acquisition source or consumed units changed') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.document,'$.allocations') a,json_each(a.value) v
 WHERE v.key IN ('beforeRaw','unitsRaw','afterRaw') AND (v.type!='text' OR length(v.value) NOT BETWEEN 1 AND 20 OR v.value GLOB '*[^0-9]*' OR (length(v.value)>1 AND substr(v.value,1,1)='0') OR (length(v.value)=20 AND v.value>'18446744073709551615')))
 OR EXISTS(SELECT 1 FROM json_each(NEW.document,'$.allocations') a WHERE json_type(a.value,'$.beforeRaw') IS NOT 'text' OR json_type(a.value,'$.afterRaw') IS NOT 'text' OR json_type(a.value,'$.unitsRaw') IS NOT 'text' OR json_extract(a.value,'$.unitsRaw')='0')
 THEN RAISE(ABORT,'Invalid launch acquisition interval') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.document,'$.allocations') a WHERE NOT EXISTS(
 WITH RECURSIVE digits(pos,carry,bad) AS (
 SELECT 1,0,0 UNION ALL SELECT pos+1,
 (carry+CAST(substr('00000000000000000000'||json_extract(a.value,'$.beforeRaw'),-pos,1) AS INTEGER)+CAST(substr('00000000000000000000'||json_extract(a.value,'$.unitsRaw'),-pos,1) AS INTEGER))/10,
 bad OR ((carry+CAST(substr('00000000000000000000'||json_extract(a.value,'$.beforeRaw'),-pos,1) AS INTEGER)+CAST(substr('00000000000000000000'||json_extract(a.value,'$.unitsRaw'),-pos,1) AS INTEGER))%10!=CAST(substr('00000000000000000000'||json_extract(a.value,'$.afterRaw'),-pos,1) AS INTEGER))
 FROM digits WHERE pos<=20) SELECT 1 FROM digits WHERE pos=21 AND carry=0 AND bad=0))
 THEN RAISE(ABORT,'Launch acquisition interval differs') END;
 SELECT CASE WHEN NOT EXISTS(WITH RECURSIVE digits(pos,carry,bad) AS (SELECT 1,0,0 UNION ALL SELECT pos+1,
 (carry+(SELECT COALESCE(SUM(CAST(substr('00000000000000000000'||json_extract(value,'$.unitsRaw'),-pos,1) AS INTEGER)),0) FROM json_each(NEW.document,'$.allocations')))/10,
 bad OR ((carry+(SELECT COALESCE(SUM(CAST(substr('00000000000000000000'||json_extract(value,'$.unitsRaw'),-pos,1) AS INTEGER)),0) FROM json_each(NEW.document,'$.allocations')))%10!=CAST(substr('00000000000000000000'||json_extract(NEW.document,'$.soldRaw'),-pos,1) AS INTEGER))
 FROM digits WHERE pos<=20) SELECT 1 FROM digits WHERE pos=21 AND carry=0 AND bad=0)
 THEN RAISE(ABORT,'Complete sale allocation required') END;
 SELECT CASE WHEN (SELECT count(*) FROM launch_sale_allocations WHERE owner_id=NEW.owner_id)>=4000 THEN RAISE(ABORT,'Launch sale history capacity reached') END;
END;
--> statement-breakpoint
CREATE TRIGGER launch_sale_allocations_no_update BEFORE UPDATE ON launch_sale_allocations BEGIN SELECT RAISE(ABORT,'Launch sale allocations are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER launch_sale_allocations_no_delete BEFORE DELETE ON launch_sale_allocations BEGIN SELECT RAISE(ABORT,'Launch sale allocations are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER launch_sale_legacy_insert BEFORE INSERT ON imported_trade_lot_links WHEN EXISTS(SELECT 1 FROM launch_sale_allocations a WHERE a.owner_id=NEW.owner_id AND (a.sale_receipt_id=NEW.sell_receipt_id OR a.sale_signature=NEW.sell_signature)) BEGIN SELECT RAISE(ABORT,'Sale already assigned to launch acquisitions'); END;
--> statement-breakpoint
CREATE TRIGGER launch_sale_legacy_update BEFORE UPDATE ON imported_trade_lot_links WHEN EXISTS(SELECT 1 FROM launch_sale_allocations a WHERE a.owner_id=NEW.owner_id AND (a.sale_receipt_id=NEW.sell_receipt_id OR a.sale_signature=NEW.sell_signature)) BEGIN SELECT RAISE(ABORT,'Sale already assigned to launch acquisitions'); END;
