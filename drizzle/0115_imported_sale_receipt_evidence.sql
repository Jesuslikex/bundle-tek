CREATE TABLE imported_sale_receipt_evidence (
 owner_id TEXT NOT NULL,
 receipt_id TEXT NOT NULL REFERENCES imported_swap_receipts(id),
 signature TEXT NOT NULL,
 parent TEXT NOT NULL CHECK(json_valid(parent)),
 parent_sha256 TEXT NOT NULL,
 evidence TEXT NOT NULL CHECK(json_valid(evidence)),
 sha256 TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,receipt_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX imported_sale_receipt_evidence_signature ON imported_sale_receipt_evidence(owner_id,signature);
--> statement-breakpoint
CREATE TRIGGER imported_sale_evidence_insert BEFORE INSERT ON imported_sale_receipt_evidence BEGIN
 SELECT CASE WHEN length(CAST(NEW.parent AS BLOB))>524288 OR length(CAST(NEW.evidence AS BLOB))>1310720
 OR length(NEW.sha256)!=64 OR NEW.sha256 GLOB '*[^a-f0-9]*'
 OR length(NEW.parent_sha256)!=64 OR NEW.parent_sha256 GLOB '*[^a-f0-9]*'
 OR json_extract(NEW.evidence,'$.format') IS NOT 'imported-sale-receipt-evidence-v1'
 OR json_extract(NEW.evidence,'$.receiptId') IS NOT NEW.receipt_id
 OR json_extract(NEW.evidence,'$.parentSha256') IS NOT NEW.parent_sha256
 OR json_extract(NEW.evidence,'$.sha256') IS NOT NEW.sha256
 OR json_extract(NEW.evidence,'$.observedAt') IS NOT NEW.created_at
 OR julianday(NEW.created_at) IS NULL
 OR json_extract(NEW.evidence,'$.report.signature') IS NOT NEW.signature
 OR json_type(NEW.evidence,'$.signingAllowed') IS NOT 'false'
 OR json_type(NEW.evidence,'$.executionAllowed') IS NOT 'false'
 OR json_type(NEW.evidence,'$.profitCalculated') IS NOT 'false'
 OR json_type(NEW.evidence,'$.acquisitionLinksChanged') IS NOT 'false'
 OR json_type(NEW.evidence,'$.economicSettlementVerified') IS NOT 'false'
 OR json_type(NEW.evidence,'$.report.signatureVerified') IS NOT 'true'
 OR json_type(NEW.evidence,'$.report.executionAllowed') IS NOT 'false'
 OR json_type(NEW.evidence,'$.report.instructionsVerified') IS NOT 'false'
 OR json_extract(NEW.evidence,'$.report.network') IS NOT 'mainnet'
 OR json_extract(NEW.evidence,'$.report.commitment') IS NOT 'finalized'
 THEN RAISE(ABORT,'Invalid retained sale evidence') END;
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM imported_swap_receipts r
  JOIN imported_swap_preparations p ON p.owner_id=r.owner_id AND p.id=r.preparation_id AND p.project_id=r.project_id AND p.project_revision=r.project_revision AND p.wallet_revision=r.wallet_revision
  JOIN imported_swap_signing_intents i ON i.owner_id=r.owner_id AND i.id=r.intent_id AND i.preparation_id=p.id AND i.signature=r.signature AND i.wallet_address=p.wallet_address AND i.state='finalized'
  JOIN solana_swap_signatures s ON s.owner_id=r.owner_id AND s.signature=r.signature AND s.scope='imported' AND s.intent_id=i.id
  WHERE r.owner_id=NEW.owner_id AND r.id=NEW.receipt_id AND r.signature=NEW.signature
  AND json_extract(r.document,'$.side')='Sell' AND json_extract(p.document,'$.side')='Sell'
  AND json_extract(NEW.parent,'$.ownerId')=r.owner_id AND json_extract(NEW.parent,'$.receiptId')=r.id
  AND json_extract(NEW.parent,'$.projectId')=r.project_id AND json_extract(NEW.parent,'$.preparationId')=p.id
  AND json_extract(NEW.parent,'$.intentId')=i.id AND json_extract(NEW.parent,'$.projectRevision')=r.project_revision
  AND json_extract(NEW.parent,'$.walletRevision')=r.wallet_revision AND json_extract(NEW.parent,'$.signature')=r.signature
  AND json_extract(NEW.parent,'$.wallet')=i.wallet_address AND json_extract(NEW.parent,'$.state')=i.state
  AND json_extract(NEW.parent,'$.receiptDocument')=r.document AND json_extract(NEW.parent,'$.preparationDocument')=p.document AND json_extract(NEW.parent,'$.approvalDocument')=i.document
  AND json_extract(NEW.evidence,'$.report.wallet')=json_extract(r.document,'$.wallet')
  AND json_extract(NEW.evidence,'$.report.mint')=json_extract(r.document,'$.mint')
  AND json_extract(NEW.evidence,'$.report.acquiredRaw')=json_extract(r.document,'$.tokenUnitsRaw')
  AND json_extract(NEW.evidence,'$.report.slot')=json_extract(r.document,'$.slot')
 ) THEN RAISE(ABORT,'Retained sale parent or registration changed') END;
 SELECT CASE WHEN (SELECT count(*) FROM imported_sale_receipt_evidence WHERE owner_id=NEW.owner_id)>=4000
 THEN RAISE(ABORT,'Retained sale evidence capacity reached') END;
END;
--> statement-breakpoint
CREATE TRIGGER imported_sale_evidence_no_update BEFORE UPDATE ON imported_sale_receipt_evidence BEGIN SELECT RAISE(ABORT,'Retained sale evidence is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER imported_sale_evidence_no_delete BEFORE DELETE ON imported_sale_receipt_evidence BEGIN SELECT RAISE(ABORT,'Retained sale evidence is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER imported_sale_parent_receipt_update BEFORE UPDATE ON imported_swap_receipts WHEN EXISTS(SELECT 1 FROM imported_sale_receipt_evidence e WHERE e.owner_id=OLD.owner_id AND e.receipt_id=OLD.id) BEGIN SELECT RAISE(ABORT,'Retained sale receipt is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER imported_sale_parent_receipt_delete BEFORE DELETE ON imported_swap_receipts WHEN EXISTS(SELECT 1 FROM imported_sale_receipt_evidence e WHERE e.owner_id=OLD.owner_id AND e.receipt_id=OLD.id) BEGIN SELECT RAISE(ABORT,'Retained sale receipt is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER imported_sale_parent_preparation_update BEFORE UPDATE ON imported_swap_preparations WHEN EXISTS(SELECT 1 FROM imported_sale_receipt_evidence e JOIN imported_swap_receipts r ON r.owner_id=e.owner_id AND r.id=e.receipt_id WHERE r.owner_id=OLD.owner_id AND r.preparation_id=OLD.id) BEGIN SELECT RAISE(ABORT,'Retained sale preparation is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER imported_sale_parent_preparation_delete BEFORE DELETE ON imported_swap_preparations WHEN EXISTS(SELECT 1 FROM imported_sale_receipt_evidence e JOIN imported_swap_receipts r ON r.owner_id=e.owner_id AND r.id=e.receipt_id WHERE r.owner_id=OLD.owner_id AND r.preparation_id=OLD.id) BEGIN SELECT RAISE(ABORT,'Retained sale preparation is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER imported_sale_parent_approval_update BEFORE UPDATE OF id,owner_id,preparation_id,wallet_address,document,state,signature ON imported_swap_signing_intents WHEN EXISTS(SELECT 1 FROM imported_sale_receipt_evidence e JOIN imported_swap_receipts r ON r.owner_id=e.owner_id AND r.id=e.receipt_id WHERE r.owner_id=OLD.owner_id AND r.intent_id=OLD.id) BEGIN SELECT RAISE(ABORT,'Retained sale approval is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER imported_sale_parent_approval_delete BEFORE DELETE ON imported_swap_signing_intents WHEN EXISTS(SELECT 1 FROM imported_sale_receipt_evidence e JOIN imported_swap_receipts r ON r.owner_id=e.owner_id AND r.id=e.receipt_id WHERE r.owner_id=OLD.owner_id AND r.intent_id=OLD.id) BEGIN SELECT RAISE(ABORT,'Retained sale approval is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER imported_sale_parent_signature_update BEFORE UPDATE ON solana_swap_signatures WHEN EXISTS(SELECT 1 FROM imported_sale_receipt_evidence e WHERE e.owner_id=OLD.owner_id AND e.signature=OLD.signature) BEGIN SELECT RAISE(ABORT,'Retained sale signature registration is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER imported_sale_parent_signature_delete BEFORE DELETE ON solana_swap_signatures WHEN EXISTS(SELECT 1 FROM imported_sale_receipt_evidence e WHERE e.owner_id=OLD.owner_id AND e.signature=OLD.signature) BEGIN SELECT RAISE(ABORT,'Retained sale signature registration is immutable'); END;
