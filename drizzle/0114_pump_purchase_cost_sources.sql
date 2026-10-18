CREATE TABLE pump_purchase_cost_batches (
 owner_id TEXT NOT NULL,
 receipt_id TEXT NOT NULL,
 review_id TEXT NOT NULL REFERENCES pump_launch_reviews(id),
 parent TEXT NOT NULL CHECK(json_valid(parent)),
 costs TEXT NOT NULL CHECK(json_valid(costs)),
 plan TEXT NOT NULL CHECK(json_valid(plan)),
 sha256 TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,receipt_id),
 FOREIGN KEY(owner_id,receipt_id) REFERENCES pump_group_receipt_evidence(owner_id,id)
);
--> statement-breakpoint
CREATE INDEX pump_purchase_cost_batches_scope ON pump_purchase_cost_batches(owner_id,review_id,receipt_id);
--> statement-breakpoint
CREATE TRIGGER pump_purchase_cost_batches_insert BEFORE INSERT ON pump_purchase_cost_batches BEGIN
 SELECT CASE WHEN length(NEW.plan)>1048576 OR length(CAST(NEW.plan AS BLOB))>1048576
 OR length(NEW.parent)>2097152 OR length(NEW.costs)>16384
 OR length(NEW.sha256)!=64 OR NEW.sha256 GLOB '*[^a-f0-9]*'
 OR json_extract(NEW.plan,'$.format') IS NOT 'pump-purchase-cost-allocation-v1'
 OR json_extract(NEW.plan,'$.policy') IS NOT 'reviewed-buy-shares-v1'
 OR json_extract(NEW.plan,'$.reviewId') IS NOT NEW.review_id
 OR json_extract(NEW.plan,'$.sha256') IS NOT NEW.sha256
 OR json_type(NEW.plan,'$.sources') IS NOT 'array'
 OR json_array_length(NEW.plan,'$.sources') NOT BETWEEN 1 AND 201
 OR json_extract(NEW.costs,'$.format') IS NOT 'pump-group-recorded-costs-v1'
 OR json_extract(NEW.costs,'$.reviewId') IS NOT NEW.review_id
 OR json_extract(NEW.costs,'$.mint') IS NOT json_extract(NEW.plan,'$.mint')
 OR json_type(NEW.costs,'$.tipLamports') IS NOT 'text'
 OR json_type(NEW.costs,'$.tipNetworkFeeLamports') IS NOT 'text'
 OR json_type(NEW.costs,'$.signingAllowed') IS NOT 'false'
 OR json_type(NEW.costs,'$.executionAllowed') IS NOT 'false'
 OR json_type(NEW.costs,'$.economicSettlementVerified') IS NOT 'false'
 OR json_type(NEW.costs,'$.profitCalculated') IS NOT 'false'
 OR json_type(NEW.costs,'$.purchasePrincipalIncluded') IS NOT 'false'
 OR json_type(NEW.costs,'$.rentIncluded') IS NOT 'false'
 OR json_type(NEW.costs,'$.reservationsChanged') IS NOT 'false'
 OR json_type(NEW.plan,'$.acquisitionBasisVerified') IS NOT 'false'
 OR json_type(NEW.plan,'$.profitCalculated') IS NOT 'false'
 OR json_type(NEW.plan,'$.signingAllowed') IS NOT 'false'
 OR json_type(NEW.plan,'$.executionAllowed') IS NOT 'false'
 OR json_type(NEW.plan,'$.reservationsChanged') IS NOT 'false'
 OR julianday(NEW.created_at) IS NULL
 THEN RAISE(ABORT,'Invalid launch buy cost batch') END;
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM pump_launch_reviews r
  JOIN pump_group_signatures s ON s.owner_id=r.owner_id AND s.review_id=r.id AND s.signed=r.signed AND s.signature=r.signature
  JOIN pump_group_receipt_evidence e ON e.owner_id=r.owner_id AND e.review_id=r.id AND e.id=NEW.receipt_id
  WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id
  AND json_extract(NEW.parent,'$.review')=r.review AND json_extract(NEW.parent,'$.signed')=r.signed
  AND json_extract(NEW.parent,'$.state')=r.state AND json_extract(NEW.parent,'$.signature')=r.signature
  AND json_extract(NEW.parent,'$.receipt')=r.receipt
  AND json_extract(r.receipt,'$.format')='pump-launch-group-broadcast-terminal-v1'
  AND json_extract(NEW.plan,'$.receiptSha256')=e.sha256
  AND json_extract(NEW.plan,'$.contextSha256')=e.context_sha256 AND e.context_sha256=s.context_sha256
  AND json_extract(NEW.plan,'$.signedGroupSha256')=e.signed_group_sha256 AND e.signed_group_sha256=s.signed_group_sha256
  AND json_extract(NEW.plan,'$.mint')=json_extract(r.review,'$.input.create.mint')
 ) THEN RAISE(ABORT,'Launch buy cost parent or receipt changed') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pump_purchase_cost_batches b WHERE b.owner_id=NEW.owner_id AND b.receipt_id=NEW.receipt_id AND (b.plan IS NOT NEW.plan OR b.costs IS NOT NEW.costs OR b.parent IS NOT NEW.parent OR b.review_id IS NOT NEW.review_id OR b.sha256 IS NOT NEW.sha256))
 THEN RAISE(ABORT,'Launch buy cost batch identity conflict') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_purchase_cost_batches_no_update BEFORE UPDATE ON pump_purchase_cost_batches BEGIN SELECT RAISE(ABORT,'Launch buy cost history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER pump_purchase_cost_batches_no_delete BEFORE DELETE ON pump_purchase_cost_batches BEGIN SELECT RAISE(ABORT,'Launch buy cost history is immutable'); END;
--> statement-breakpoint
CREATE TABLE pump_purchase_cost_sources (
 owner_id TEXT NOT NULL,
 origin_id TEXT NOT NULL,
 receipt_id TEXT NOT NULL,
 review_id TEXT NOT NULL,
 mint TEXT NOT NULL,
 wallet TEXT NOT NULL,
 source TEXT NOT NULL CHECK(json_valid(source)),
 sha256 TEXT NOT NULL,
 PRIMARY KEY(owner_id,origin_id),
 FOREIGN KEY(owner_id,receipt_id) REFERENCES pump_purchase_cost_batches(owner_id,receipt_id)
);
--> statement-breakpoint
CREATE INDEX pump_purchase_cost_sources_scope ON pump_purchase_cost_sources(owner_id,review_id,origin_id);
--> statement-breakpoint
CREATE INDEX pump_purchase_cost_sources_inventory ON pump_purchase_cost_sources(owner_id,mint,wallet,origin_id);
--> statement-breakpoint
CREATE TRIGGER pump_purchase_cost_sources_insert BEFORE INSERT ON pump_purchase_cost_sources BEGIN
 SELECT CASE WHEN length(NEW.origin_id)!=64 OR NEW.origin_id GLOB '*[^a-f0-9]*'
 OR length(NEW.sha256)!=64 OR NEW.sha256 GLOB '*[^a-f0-9]*' OR length(NEW.source)>16384
 OR json_extract(NEW.source,'$.originId') IS NOT NEW.origin_id
 OR json_extract(NEW.source,'$.reviewId') IS NOT NEW.review_id
 OR json_extract(NEW.source,'$.mint') IS NOT NEW.mint OR json_extract(NEW.source,'$.wallet') IS NOT NEW.wallet
 OR json_extract(NEW.source,'$.sha256') IS NOT NEW.sha256
 OR json_extract(NEW.source,'$.policy') IS NOT 'reviewed-buy-shares-v1'
 OR json_type(NEW.source,'$.acquisitionBasisVerified') IS NOT 'false'
 OR json_type(NEW.source,'$.executionAllowed') IS NOT 'false'
 OR NOT EXISTS (SELECT 1 FROM pump_purchase_cost_batches b, json_each(b.plan,'$.sources') p
  WHERE b.owner_id=NEW.owner_id AND b.receipt_id=NEW.receipt_id AND b.review_id=NEW.review_id
  AND json_extract(p.value,'$.originId')=NEW.origin_id AND p.value=json(NEW.source))
 THEN RAISE(ABORT,'Invalid launch buy cost source') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pump_purchase_cost_sources p WHERE p.owner_id=NEW.owner_id AND p.origin_id=NEW.origin_id AND (p.review_id IS NOT NEW.review_id OR p.source IS NOT NEW.source OR p.sha256 IS NOT NEW.sha256 OR p.wallet IS NOT NEW.wallet OR p.mint IS NOT NEW.mint))
 THEN RAISE(ABORT,'Launch buy origin already has different recorded costs') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_purchase_cost_sources_no_update BEFORE UPDATE ON pump_purchase_cost_sources BEGIN SELECT RAISE(ABORT,'Launch buy cost source is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER pump_purchase_cost_sources_no_delete BEFORE DELETE ON pump_purchase_cost_sources BEGIN SELECT RAISE(ABORT,'Launch buy cost source is immutable'); END;
