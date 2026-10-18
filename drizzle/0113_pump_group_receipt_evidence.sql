CREATE TABLE pump_group_receipt_evidence (
 id TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 review_id TEXT NOT NULL REFERENCES pump_launch_reviews(id),
 context_sha256 TEXT NOT NULL,
 signed_group_sha256 TEXT NOT NULL,
 sha256 TEXT NOT NULL,
 evidence TEXT NOT NULL CHECK(json_valid(evidence)),
 created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,id)
);
--> statement-breakpoint
CREATE INDEX pump_group_receipt_evidence_owner ON pump_group_receipt_evidence(owner_id,review_id,created_at,id);
--> statement-breakpoint
CREATE TRIGGER pump_group_receipt_evidence_insert BEFORE INSERT ON pump_group_receipt_evidence BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM pump_launch_reviews r JOIN pump_group_signatures s ON s.review_id=r.id AND s.owner_id=r.owner_id
  WHERE r.id=NEW.review_id AND r.owner_id=NEW.owner_id AND r.signed=s.signed AND r.signature=s.signature
  AND json_extract(r.review,'$.format')='pump-launch-group-review-v1'
  AND json_extract(r.review,'$.contextSha256')=NEW.context_sha256
  AND s.context_sha256=NEW.context_sha256
  AND s.manifest_sha256=json_extract(r.review,'$.manifestSha256')
  AND s.signed_group_sha256=NEW.signed_group_sha256
  AND json_extract(r.signed,'$.signedGroupSha256')=NEW.signed_group_sha256
 ) THEN RAISE(ABORT,'Launch receipt parent/signature changed') END;
 SELECT CASE WHEN length(NEW.id)!=36 OR NEW.id GLOB '*[^a-f0-9-]*'
 OR substr(NEW.id,9,1)!='-' OR substr(NEW.id,14,1)!='-' OR substr(NEW.id,19,1)!='-' OR substr(NEW.id,24,1)!='-'
 OR length(NEW.evidence)>2097152
 OR length(CAST(NEW.evidence AS BLOB))>2097152
 OR length(NEW.sha256)!=64 OR NEW.sha256 GLOB '*[^a-f0-9]*'
 OR json_extract(NEW.evidence,'$.format') IS NOT 'pump-group-receipt-evidence-v1'
 OR json_extract(NEW.evidence,'$.report.format') IS NOT 'pump-group-chain-effects-v1'
 OR json_extract(NEW.evidence,'$.sha256') IS NOT NEW.sha256
 OR json_extract(NEW.evidence,'$.report.reviewId') IS NOT NEW.review_id
 OR json_extract(NEW.evidence,'$.report.contextSha256') IS NOT NEW.context_sha256
 OR json_extract(NEW.evidence,'$.report.signedGroupSha256') IS NOT NEW.signed_group_sha256
 OR json_extract(NEW.evidence,'$.report.mint') IS NOT (SELECT json_extract(review,'$.input.create.mint') FROM pump_launch_reviews WHERE id=NEW.review_id AND owner_id=NEW.owner_id)
 OR json_extract(NEW.evidence,'$.report.observedAt') IS NOT NEW.created_at
 OR julianday(NEW.created_at) IS NULL
 OR abs(julianday('now')-julianday(NEW.created_at))>60.0/86400
 OR json_type(NEW.evidence,'$.receipts') IS NOT 'array'
 OR json_array_length(NEW.evidence,'$.receipts') IS NOT (SELECT json_array_length(signed,'$.packets') FROM pump_launch_reviews WHERE id=NEW.review_id AND owner_id=NEW.owner_id)
 OR json_type(NEW.evidence,'$.report.packets') IS NOT 'array'
 OR json_array_length(NEW.evidence,'$.report.packets') IS NOT json_array_length(NEW.evidence,'$.receipts')
 OR json_type(NEW.evidence,'$.acquisitionBasisVerified') IS NOT 'false'
 OR json_type(NEW.evidence,'$.signingAllowed') IS NOT 'false'
 OR json_type(NEW.evidence,'$.executionAllowed') IS NOT 'false'
 OR json_type(NEW.evidence,'$.reservationsChanged') IS NOT 'false'
 OR json_type(NEW.evidence,'$.report.economicSettlementVerified') IS NOT 'false'
 OR json_type(NEW.evidence,'$.report.atomicityVerified') IS NOT 'false'
 OR json_type(NEW.evidence,'$.report.currentHoldings') IS NOT 'false'
 OR json_type(NEW.evidence,'$.report.tipIncluded') IS NOT 'false'
 OR json_type(NEW.evidence,'$.report.executionAllowed') IS NOT 'false'
 OR json_type(NEW.evidence,'$.report.reservationsChanged') IS NOT 'false'
 THEN RAISE(ABORT,'Invalid launch receipt evidence scope') END;
 SELECT CASE WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.evidence,'$.receipts') p JOIN pump_launch_reviews r ON r.id=NEW.review_id AND r.owner_id=NEW.owner_id
  WHERE json_extract(NEW.evidence,'$.report.packets['||p.key||'].index') IS NOT CAST(p.key AS INTEGER)
  OR json_extract(NEW.evidence,'$.report.packets['||p.key||'].signature') IS NOT json_extract(r.signed,'$.packets['||p.key||'].signature')
  OR (p.type='null' AND json_extract(NEW.evidence,'$.report.packets['||p.key||'].outcome') IS NOT 'not-observed')
  OR (p.type!='null' AND (p.type!='object'
   OR json_extract(p.value,'$.transaction[0]') IS NOT json_extract(r.signed,'$.packets['||p.key||'].transaction')
   OR json_extract(p.value,'$.transaction[1]') IS NOT 'base64'
   OR json_extract(NEW.evidence,'$.report.packets['||p.key||'].outcome') IS NOT CASE WHEN json_type(p.value,'$.meta.err')='null' THEN 'success' ELSE 'failed' END))
 ) OR NOT EXISTS(SELECT 1 FROM json_each(NEW.evidence,'$.receipts') WHERE type='object')
 THEN RAISE(ABORT,'Launch receipt packet identity differs') END;
 SELECT CASE WHEN (SELECT count(*) FROM pump_group_receipt_evidence WHERE owner_id=NEW.owner_id AND review_id=NEW.review_id)>=8
 OR (SELECT count(*) FROM pump_group_receipt_evidence WHERE owner_id=NEW.owner_id)>=128
 THEN RAISE(ABORT,'Launch receipt evidence capacity reached') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_group_receipt_evidence_no_update BEFORE UPDATE ON pump_group_receipt_evidence BEGIN SELECT RAISE(ABORT,'Launch receipt history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER pump_group_receipt_evidence_no_delete BEFORE DELETE ON pump_group_receipt_evidence BEGIN SELECT RAISE(ABORT,'Launch receipt history is immutable'); END;
