CREATE TABLE wallet_warmup_session_settlements (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,journal_id TEXT NOT NULL,action_id TEXT NOT NULL,
 side TEXT NOT NULL CHECK(side IN ('Buy','Sell')),receipt_id TEXT NOT NULL,signature TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('applied','held')),
 document TEXT NOT NULL CHECK(json_valid(document)),record_sha256 TEXT NOT NULL,
 source TEXT NOT NULL CHECK(json_valid(source)),event_document TEXT NOT NULL CHECK(json_valid(event_document)),event_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,journal_id,action_id),UNIQUE(owner_id,side,receipt_id),UNIQUE(owner_id,signature),
 FOREIGN KEY(owner_id,journal_id) REFERENCES wallet_warmup_session_journals(owner_id,id)
);
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_settlements_insert BEFORE INSERT ON wallet_warmup_session_settlements BEGIN
 SELECT CASE WHEN length(NEW.id)!=36 OR NEW.id GLOB '*[^a-f0-9-]*' OR length(replace(NEW.id,'-',''))!=32
 OR substr(NEW.id,9,1)!='-' OR substr(NEW.id,14,1)!='-' OR substr(NEW.id,19,1)!='-' OR substr(NEW.id,24,1)!='-'
 OR length(NEW.record_sha256)!=64 OR NEW.record_sha256 GLOB '*[^a-f0-9]*'
 OR length(CAST(NEW.document AS BLOB))>16384 OR length(CAST(NEW.source AS BLOB))>4194304
 OR (SELECT count(*) FROM json_each(NEW.document))!=17
 OR json_extract(NEW.document,'$.format') IS NOT 'wallet-warmup-session-settlement-v1'
 OR json_extract(NEW.document,'$.id') IS NOT NEW.id OR json_extract(NEW.document,'$.journalId') IS NOT NEW.journal_id
 OR json_extract(NEW.document,'$.actionId') IS NOT NEW.action_id OR json_extract(NEW.document,'$.receiptId') IS NOT NEW.receipt_id
 OR json_extract(NEW.document,'$.createdAt') IS NOT NEW.created_at OR json_extract(NEW.document,'$.mode') IS NOT NEW.mode
 OR json_extract(NEW.document,'$.scope') IS NOT 'owned-signature-packet-finalized-balances'
 OR json_type(NEW.document,'$.executionAllowed') IS NOT 'false' OR json_type(NEW.document,'$.signingAllowed') IS NOT 'false' OR json_type(NEW.document,'$.automaticExecutionAllowed') IS NOT 'false'
 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) IS NOT NEW.created_at
 OR json_type(NEW.document,'$.sourceSha256') IS NOT 'text' OR length(json_extract(NEW.document,'$.sourceSha256'))!=64 OR json_extract(NEW.document,'$.sourceSha256') GLOB '*[^a-f0-9]*'
 OR json_extract(NEW.document,'$.settlement.side') IS NOT NEW.side OR json_extract(NEW.document,'$.settlement.actionId') IS NOT NEW.action_id OR json_extract(NEW.document,'$.settlement.receiptId') IS NOT NEW.receipt_id
 OR json_extract(NEW.document,'$.settlement.network') IS NOT 'mainnet' OR json_extract(NEW.document,'$.settlement.commitment') IS NOT 'finalized' OR json_type(NEW.document,'$.settlement.verified') IS NOT 'true'
 OR json_extract(NEW.source,'$[0].receiptId') IS NOT NEW.receipt_id OR json_extract(NEW.source,'$[0].receiptSignature') IS NOT NEW.signature
 OR json_extract(NEW.source,'$[0].approvalState') IS NOT 'finalized' OR json_extract(NEW.source,'$[0].approvalSignature') IS NOT NEW.signature
 OR json_extract(NEW.source,'$[0].approvalPreparationId') IS NOT json_extract(NEW.source,'$[0].preparationId')
 OR json_extract(NEW.document,'$.settlement.planId') IS NOT json_extract(NEW.source,'$[0].planId') OR json_extract(NEW.document,'$.settlement.planId') IS NOT json_extract(NEW.source,'$[0].receiptPlanId')
 OR json_extract(NEW.document,'$.settlement.planRevision') IS NOT json_extract(NEW.source,'$[0].planRevision') OR json_extract(NEW.document,'$.settlement.walletRevision') IS NOT json_extract(NEW.source,'$[0].walletRevision')
 OR json_extract(NEW.document,'$.settlement.wallet') IS NOT json_extract(NEW.source,'$[0].approvalWallet') OR json_extract(NEW.document,'$.settlement.wallet') IS NOT json_extract(json_extract(NEW.source,'$[0].receiptDocument'),'$.wallet') OR json_extract(NEW.document,'$.settlement.mint') IS NOT json_extract(json_extract(NEW.source,'$[0].receiptDocument'),'$.mint')
 OR json_extract(NEW.document,'$.settlement.networkFeeLamports') IS NOT json_extract(json_extract(NEW.source,'$[0].receiptDocument'),'$.networkFeeLamports') OR json_extract(NEW.document,'$.settlement.rentChangeLamports') IS NOT json_extract(json_extract(NEW.source,'$[0].receiptDocument'),'$.rentChangeRaw')
 OR json_extract(json_extract(NEW.source,'$[0].receiptDocument'),'$.network') IS NOT 'mainnet' OR json_extract(json_extract(NEW.source,'$[0].receiptDocument'),'$.commitment') IS NOT 'finalized' OR json_type(json_extract(NEW.source,'$[0].receiptDocument'),'$.signatureVerified') IS NOT 'true' OR json_extract(json_extract(NEW.source,'$[0].receiptDocument'),'$.signature') IS NOT NEW.signature
 OR (NEW.side='Buy' AND (substr(json_extract(json_extract(NEW.source,'$[0].receiptDocument'),'$.nativeSettlementRaw'),1,1)!='-' OR json_extract(NEW.document,'$.settlement.inputLamports') IS NOT substr(json_extract(json_extract(NEW.source,'$[0].receiptDocument'),'$.nativeSettlementRaw'),2) OR json_extract(NEW.document,'$.settlement.acquiredRaw') IS NOT json_extract(json_extract(NEW.source,'$[0].receiptDocument'),'$.acquiredRaw') OR json_extract(NEW.document,'$.settlement.decimals') IS NOT json_extract(json_extract(NEW.source,'$[0].receiptDocument'),'$.decimals')))
 OR (NEW.side='Sell' AND (json_extract(NEW.document,'$.settlement.buyReceiptId') IS NOT json_extract(NEW.source,'$[0].buyReceiptId') OR json_extract(NEW.document,'$.settlement.consumedRaw') IS NOT json_extract(NEW.source,'$[0].consumedRaw') OR json_extract(NEW.document,'$.settlement.consumedRaw') IS NOT json_extract(json_extract(NEW.source,'$[0].receiptDocument'),'$.consumedRaw')))
 OR length(NEW.event_sha256)!=64 OR NEW.event_sha256 GLOB '*[^a-f0-9]*'
 OR json_extract(NEW.event_document,'$.eventId') IS NOT NEW.id OR json_extract(NEW.event_document,'$.actionId') IS NOT NEW.action_id OR json_extract(NEW.event_document,'$.at') IS NOT NEW.created_at OR json_extract(NEW.event_document,'$.proofSha256') IS NOT NEW.record_sha256
 OR json_extract(NEW.event_document,'$.version') IS NOT json_extract(NEW.document,'$.version')+1 OR json_extract(NEW.event_document,'$.previousSha256') IS NOT json_extract(NEW.document,'$.headSha256')
 OR (NEW.mode='held' AND (json_extract(NEW.event_document,'$.operation') IS NOT 'unknown' OR json_type(NEW.event_document,'$.settlement') IS NOT NULL OR json_extract(NEW.document,'$.reason') IS NOT 'sequence-refused'))
 OR (NEW.mode='applied' AND (json_type(NEW.document,'$.reason') IS NOT 'null' OR json_extract(NEW.event_document,'$.operation') IS NOT 'finalized' OR json_extract(NEW.event_document,'$.settlement') IS NOT json_extract(NEW.document,'$.settlement')))
 OR EXISTS(SELECT 1 FROM wallet_warmup_session_journal_events e WHERE e.owner_id=NEW.owner_id AND e.id=NEW.id)
 OR EXISTS(SELECT 1 FROM wallet_warmup_session_settlements p WHERE p.owner_id=NEW.owner_id AND (p.id=NEW.id OR (p.journal_id=NEW.journal_id AND p.action_id=NEW.action_id) OR p.signature=NEW.signature OR (p.side=NEW.side AND p.receipt_id=NEW.receipt_id)))
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_session_journals j JOIN wallet_warmup_session_journal_heads h ON h.owner_id=j.owner_id AND h.journal_id=j.id,json_each(j.source_document,'$.review.actions') a WHERE j.owner_id=NEW.owner_id AND j.id=NEW.journal_id
 AND h.version=json_extract(NEW.document,'$.version') AND h.head_sha256=json_extract(NEW.document,'$.headSha256') AND NEW.created_at>=h.updated_at
 AND json_extract(a.value,'$.id')=NEW.action_id AND json_extract(NEW.document,'$.candidate.action')=a.value
 AND json_extract(j.source_document,'$.review.planId')=json_extract(NEW.document,'$.settlement.planId') AND json_extract(j.source_document,'$.review.planRevision')=json_extract(NEW.document,'$.settlement.planRevision')
 AND json_extract(NEW.document,'$.candidate.action.side')=NEW.side AND json_type(NEW.document,'$.candidate.executionAllowed')='false' AND json_type(NEW.document,'$.candidate.signingAllowed')='false'
 AND (SELECT json_extract(e.document,'$.actionId') FROM wallet_warmup_session_journal_events e WHERE e.owner_id=NEW.owner_id AND e.journal_id=NEW.journal_id AND json_extract(e.document,'$.operation')='begin-review' ORDER BY e.version DESC LIMIT 1)=NEW.action_id
 AND (SELECT json_extract(e.document,'$.operation') FROM wallet_warmup_session_journal_events e WHERE e.owner_id=NEW.owner_id AND e.journal_id=NEW.journal_id AND json_extract(e.document,'$.actionId')=NEW.action_id ORDER BY e.version DESC LIMIT 1) IN ('submitted','unknown'))
 THEN RAISE(ABORT,'Verified settlement context changed') END;
 SELECT CASE WHEN json_type(NEW.source) IS NOT 'array' OR json_array_length(NEW.source)!=2
 OR (NEW.side='Buy' AND (json_type(NEW.source,'$[1]') IS NOT 'null' OR NOT EXISTS(SELECT 1 FROM (SELECT r.id AS receiptId,r.plan_id AS receiptPlanId,r.signature AS receiptSignature,r.document AS receiptDocument,r.wallet_address AS receiptWallet,r.remaining_raw AS remainingRaw,r.plan_revision AS receiptPlanRevision,r.wallet_revision AS receiptWalletRevision,r.cycle AS receiptCycle,NULL AS buyReceiptId,NULL AS consumedRaw,
    s.id AS preparationId,s.plan_id AS planId,s.plan_revision AS planRevision,s.cycle,s.wallet_revision AS walletRevision,s.created_at AS preparationCreatedAt,s.document AS preparationDocument,
    i.id AS approvalId,i.preparation_id AS approvalPreparationId,i.wallet_address AS approvalWallet,i.signature AS approvalSignature,i.state AS approvalState,i.document AS approvalDocument
    FROM warmup_buy_receipts r JOIN warmup_swap_preparations s ON s.owner_id=r.owner_id AND s.id=r.preparation_id
    JOIN warmup_signing_intents i ON i.owner_id=s.owner_id AND i.preparation_id=s.id
    WHERE r.owner_id=NEW.owner_id AND r.id=json_extract(NEW.source,'$[0].receiptId') AND r.plan_id=json_extract(NEW.source,'$[0].receiptPlanId') AND EXISTS(SELECT 1 FROM wallet_warmup_plans p WHERE p.owner_id=r.owner_id AND p.id=r.plan_id)) captured WHERE (json_type(NEW.source,'$[0].receiptWallet') IS typeof(captured.receiptWallet) AND captured.receiptWallet IS json_extract(NEW.source,'$[0].receiptWallet'))
 AND (json_type(NEW.source,'$[0].remainingRaw') IS typeof(captured.remainingRaw) AND captured.remainingRaw IS json_extract(NEW.source,'$[0].remainingRaw'))
 AND (json_type(NEW.source,'$[0].receiptId') IS typeof(captured.receiptId) AND captured.receiptId IS json_extract(NEW.source,'$[0].receiptId'))
 AND (json_type(NEW.source,'$[0].receiptPlanId') IS typeof(captured.receiptPlanId) AND captured.receiptPlanId IS json_extract(NEW.source,'$[0].receiptPlanId'))
 AND (json_type(NEW.source,'$[0].receiptSignature') IS typeof(captured.receiptSignature) AND captured.receiptSignature IS json_extract(NEW.source,'$[0].receiptSignature'))
 AND (json_type(NEW.source,'$[0].receiptDocument') IS typeof(captured.receiptDocument) AND captured.receiptDocument IS json_extract(NEW.source,'$[0].receiptDocument'))
 AND (json_type(NEW.source,'$[0].receiptPlanRevision') IS typeof(captured.receiptPlanRevision) AND captured.receiptPlanRevision IS json_extract(NEW.source,'$[0].receiptPlanRevision'))
 AND (json_type(NEW.source,'$[0].receiptWalletRevision') IS typeof(captured.receiptWalletRevision) AND captured.receiptWalletRevision IS json_extract(NEW.source,'$[0].receiptWalletRevision'))
 AND (json_type(NEW.source,'$[0].receiptCycle') IS typeof(captured.receiptCycle) AND captured.receiptCycle IS json_extract(NEW.source,'$[0].receiptCycle'))
 AND (json_type(NEW.source,'$[0].buyReceiptId') IS typeof(captured.buyReceiptId) AND captured.buyReceiptId IS json_extract(NEW.source,'$[0].buyReceiptId'))
 AND (json_type(NEW.source,'$[0].consumedRaw') IS typeof(captured.consumedRaw) AND captured.consumedRaw IS json_extract(NEW.source,'$[0].consumedRaw'))
 AND (json_type(NEW.source,'$[0].preparationId') IS typeof(captured.preparationId) AND captured.preparationId IS json_extract(NEW.source,'$[0].preparationId'))
 AND (json_type(NEW.source,'$[0].planId') IS typeof(captured.planId) AND captured.planId IS json_extract(NEW.source,'$[0].planId'))
 AND (json_type(NEW.source,'$[0].planRevision') IS typeof(captured.planRevision) AND captured.planRevision IS json_extract(NEW.source,'$[0].planRevision'))
 AND (json_type(NEW.source,'$[0].cycle') IS typeof(captured.cycle) AND captured.cycle IS json_extract(NEW.source,'$[0].cycle'))
 AND (json_type(NEW.source,'$[0].walletRevision') IS typeof(captured.walletRevision) AND captured.walletRevision IS json_extract(NEW.source,'$[0].walletRevision'))
 AND (json_type(NEW.source,'$[0].preparationCreatedAt') IS typeof(captured.preparationCreatedAt) AND captured.preparationCreatedAt IS json_extract(NEW.source,'$[0].preparationCreatedAt'))
 AND (json_type(NEW.source,'$[0].preparationDocument') IS typeof(captured.preparationDocument) AND captured.preparationDocument IS json_extract(NEW.source,'$[0].preparationDocument'))
 AND (json_type(NEW.source,'$[0].approvalId') IS typeof(captured.approvalId) AND captured.approvalId IS json_extract(NEW.source,'$[0].approvalId'))
 AND (json_type(NEW.source,'$[0].approvalPreparationId') IS typeof(captured.approvalPreparationId) AND captured.approvalPreparationId IS json_extract(NEW.source,'$[0].approvalPreparationId'))
 AND (json_type(NEW.source,'$[0].approvalWallet') IS typeof(captured.approvalWallet) AND captured.approvalWallet IS json_extract(NEW.source,'$[0].approvalWallet'))
 AND (json_type(NEW.source,'$[0].approvalSignature') IS typeof(captured.approvalSignature) AND captured.approvalSignature IS json_extract(NEW.source,'$[0].approvalSignature'))
 AND (json_type(NEW.source,'$[0].approvalState') IS typeof(captured.approvalState) AND captured.approvalState IS json_extract(NEW.source,'$[0].approvalState'))
 AND (json_type(NEW.source,'$[0].approvalDocument') IS typeof(captured.approvalDocument) AND captured.approvalDocument IS json_extract(NEW.source,'$[0].approvalDocument')))))
 OR (NEW.side='Sell' AND (json_type(NEW.source,'$[1]') IS NOT 'object' OR json_extract(NEW.source,'$[1].approvalState') IS NOT 'finalized' OR json_extract(NEW.source,'$[0].buyReceiptId') IS NOT json_extract(NEW.source,'$[1].receiptId') OR json_extract(NEW.source,'$[0].receiptPlanId') IS NOT json_extract(NEW.source,'$[1].receiptPlanId') OR NOT EXISTS(SELECT 1 FROM (SELECT r.id AS receiptId,r.plan_id AS receiptPlanId,r.signature AS receiptSignature,r.document AS receiptDocument,NULL AS receiptWallet,NULL AS remainingRaw,NULL AS receiptPlanRevision,NULL AS receiptWalletRevision,NULL AS receiptCycle,r.buy_receipt_id AS buyReceiptId,r.consumed_raw AS consumedRaw,
    s.id AS preparationId,s.plan_id AS planId,s.plan_revision AS planRevision,s.cycle,s.wallet_revision AS walletRevision,s.created_at AS preparationCreatedAt,s.document AS preparationDocument,
    i.id AS approvalId,i.preparation_id AS approvalPreparationId,i.wallet_address AS approvalWallet,i.signature AS approvalSignature,i.state AS approvalState,i.document AS approvalDocument
    FROM warmup_sell_receipts r JOIN warmup_swap_preparations s ON s.owner_id=r.owner_id AND s.id=r.preparation_id
    JOIN warmup_signing_intents i ON i.owner_id=s.owner_id AND i.preparation_id=s.id
    WHERE r.owner_id=NEW.owner_id AND r.id=json_extract(NEW.source,'$[0].receiptId') AND r.plan_id=json_extract(NEW.source,'$[0].receiptPlanId') AND EXISTS(SELECT 1 FROM wallet_warmup_plans p WHERE p.owner_id=r.owner_id AND p.id=r.plan_id)) captured WHERE (json_type(NEW.source,'$[0].receiptWallet') IS typeof(captured.receiptWallet) AND captured.receiptWallet IS json_extract(NEW.source,'$[0].receiptWallet'))
 AND (json_type(NEW.source,'$[0].remainingRaw') IS typeof(captured.remainingRaw) AND captured.remainingRaw IS json_extract(NEW.source,'$[0].remainingRaw'))
 AND (json_type(NEW.source,'$[0].receiptId') IS typeof(captured.receiptId) AND captured.receiptId IS json_extract(NEW.source,'$[0].receiptId'))
 AND (json_type(NEW.source,'$[0].receiptPlanId') IS typeof(captured.receiptPlanId) AND captured.receiptPlanId IS json_extract(NEW.source,'$[0].receiptPlanId'))
 AND (json_type(NEW.source,'$[0].receiptSignature') IS typeof(captured.receiptSignature) AND captured.receiptSignature IS json_extract(NEW.source,'$[0].receiptSignature'))
 AND (json_type(NEW.source,'$[0].receiptDocument') IS typeof(captured.receiptDocument) AND captured.receiptDocument IS json_extract(NEW.source,'$[0].receiptDocument'))
 AND (json_type(NEW.source,'$[0].receiptPlanRevision') IS typeof(captured.receiptPlanRevision) AND captured.receiptPlanRevision IS json_extract(NEW.source,'$[0].receiptPlanRevision'))
 AND (json_type(NEW.source,'$[0].receiptWalletRevision') IS typeof(captured.receiptWalletRevision) AND captured.receiptWalletRevision IS json_extract(NEW.source,'$[0].receiptWalletRevision'))
 AND (json_type(NEW.source,'$[0].receiptCycle') IS typeof(captured.receiptCycle) AND captured.receiptCycle IS json_extract(NEW.source,'$[0].receiptCycle'))
 AND (json_type(NEW.source,'$[0].buyReceiptId') IS typeof(captured.buyReceiptId) AND captured.buyReceiptId IS json_extract(NEW.source,'$[0].buyReceiptId'))
 AND (json_type(NEW.source,'$[0].consumedRaw') IS typeof(captured.consumedRaw) AND captured.consumedRaw IS json_extract(NEW.source,'$[0].consumedRaw'))
 AND (json_type(NEW.source,'$[0].preparationId') IS typeof(captured.preparationId) AND captured.preparationId IS json_extract(NEW.source,'$[0].preparationId'))
 AND (json_type(NEW.source,'$[0].planId') IS typeof(captured.planId) AND captured.planId IS json_extract(NEW.source,'$[0].planId'))
 AND (json_type(NEW.source,'$[0].planRevision') IS typeof(captured.planRevision) AND captured.planRevision IS json_extract(NEW.source,'$[0].planRevision'))
 AND (json_type(NEW.source,'$[0].cycle') IS typeof(captured.cycle) AND captured.cycle IS json_extract(NEW.source,'$[0].cycle'))
 AND (json_type(NEW.source,'$[0].walletRevision') IS typeof(captured.walletRevision) AND captured.walletRevision IS json_extract(NEW.source,'$[0].walletRevision'))
 AND (json_type(NEW.source,'$[0].preparationCreatedAt') IS typeof(captured.preparationCreatedAt) AND captured.preparationCreatedAt IS json_extract(NEW.source,'$[0].preparationCreatedAt'))
 AND (json_type(NEW.source,'$[0].preparationDocument') IS typeof(captured.preparationDocument) AND captured.preparationDocument IS json_extract(NEW.source,'$[0].preparationDocument'))
 AND (json_type(NEW.source,'$[0].approvalId') IS typeof(captured.approvalId) AND captured.approvalId IS json_extract(NEW.source,'$[0].approvalId'))
 AND (json_type(NEW.source,'$[0].approvalPreparationId') IS typeof(captured.approvalPreparationId) AND captured.approvalPreparationId IS json_extract(NEW.source,'$[0].approvalPreparationId'))
 AND (json_type(NEW.source,'$[0].approvalWallet') IS typeof(captured.approvalWallet) AND captured.approvalWallet IS json_extract(NEW.source,'$[0].approvalWallet'))
 AND (json_type(NEW.source,'$[0].approvalSignature') IS typeof(captured.approvalSignature) AND captured.approvalSignature IS json_extract(NEW.source,'$[0].approvalSignature'))
 AND (json_type(NEW.source,'$[0].approvalState') IS typeof(captured.approvalState) AND captured.approvalState IS json_extract(NEW.source,'$[0].approvalState'))
 AND (json_type(NEW.source,'$[0].approvalDocument') IS typeof(captured.approvalDocument) AND captured.approvalDocument IS json_extract(NEW.source,'$[0].approvalDocument'))) OR NOT EXISTS(SELECT 1 FROM (SELECT r.id AS receiptId,r.plan_id AS receiptPlanId,r.signature AS receiptSignature,r.document AS receiptDocument,r.wallet_address AS receiptWallet,r.remaining_raw AS remainingRaw,r.plan_revision AS receiptPlanRevision,r.wallet_revision AS receiptWalletRevision,r.cycle AS receiptCycle,NULL AS buyReceiptId,NULL AS consumedRaw,
    s.id AS preparationId,s.plan_id AS planId,s.plan_revision AS planRevision,s.cycle,s.wallet_revision AS walletRevision,s.created_at AS preparationCreatedAt,s.document AS preparationDocument,
    i.id AS approvalId,i.preparation_id AS approvalPreparationId,i.wallet_address AS approvalWallet,i.signature AS approvalSignature,i.state AS approvalState,i.document AS approvalDocument
    FROM warmup_buy_receipts r JOIN warmup_swap_preparations s ON s.owner_id=r.owner_id AND s.id=r.preparation_id
    JOIN warmup_signing_intents i ON i.owner_id=s.owner_id AND i.preparation_id=s.id
    WHERE r.owner_id=NEW.owner_id AND r.id=json_extract(NEW.source,'$[1].receiptId') AND r.plan_id=json_extract(NEW.source,'$[1].receiptPlanId') AND EXISTS(SELECT 1 FROM wallet_warmup_plans p WHERE p.owner_id=r.owner_id AND p.id=r.plan_id)) captured WHERE (json_type(NEW.source,'$[1].receiptWallet') IS typeof(captured.receiptWallet) AND captured.receiptWallet IS json_extract(NEW.source,'$[1].receiptWallet'))
 AND (json_type(NEW.source,'$[1].remainingRaw') IS typeof(captured.remainingRaw) AND captured.remainingRaw IS json_extract(NEW.source,'$[1].remainingRaw'))
 AND (json_type(NEW.source,'$[1].receiptId') IS typeof(captured.receiptId) AND captured.receiptId IS json_extract(NEW.source,'$[1].receiptId'))
 AND (json_type(NEW.source,'$[1].receiptPlanId') IS typeof(captured.receiptPlanId) AND captured.receiptPlanId IS json_extract(NEW.source,'$[1].receiptPlanId'))
 AND (json_type(NEW.source,'$[1].receiptSignature') IS typeof(captured.receiptSignature) AND captured.receiptSignature IS json_extract(NEW.source,'$[1].receiptSignature'))
 AND (json_type(NEW.source,'$[1].receiptDocument') IS typeof(captured.receiptDocument) AND captured.receiptDocument IS json_extract(NEW.source,'$[1].receiptDocument'))
 AND (json_type(NEW.source,'$[1].receiptPlanRevision') IS typeof(captured.receiptPlanRevision) AND captured.receiptPlanRevision IS json_extract(NEW.source,'$[1].receiptPlanRevision'))
 AND (json_type(NEW.source,'$[1].receiptWalletRevision') IS typeof(captured.receiptWalletRevision) AND captured.receiptWalletRevision IS json_extract(NEW.source,'$[1].receiptWalletRevision'))
 AND (json_type(NEW.source,'$[1].receiptCycle') IS typeof(captured.receiptCycle) AND captured.receiptCycle IS json_extract(NEW.source,'$[1].receiptCycle'))
 AND (json_type(NEW.source,'$[1].buyReceiptId') IS typeof(captured.buyReceiptId) AND captured.buyReceiptId IS json_extract(NEW.source,'$[1].buyReceiptId'))
 AND (json_type(NEW.source,'$[1].consumedRaw') IS typeof(captured.consumedRaw) AND captured.consumedRaw IS json_extract(NEW.source,'$[1].consumedRaw'))
 AND (json_type(NEW.source,'$[1].preparationId') IS typeof(captured.preparationId) AND captured.preparationId IS json_extract(NEW.source,'$[1].preparationId'))
 AND (json_type(NEW.source,'$[1].planId') IS typeof(captured.planId) AND captured.planId IS json_extract(NEW.source,'$[1].planId'))
 AND (json_type(NEW.source,'$[1].planRevision') IS typeof(captured.planRevision) AND captured.planRevision IS json_extract(NEW.source,'$[1].planRevision'))
 AND (json_type(NEW.source,'$[1].cycle') IS typeof(captured.cycle) AND captured.cycle IS json_extract(NEW.source,'$[1].cycle'))
 AND (json_type(NEW.source,'$[1].walletRevision') IS typeof(captured.walletRevision) AND captured.walletRevision IS json_extract(NEW.source,'$[1].walletRevision'))
 AND (json_type(NEW.source,'$[1].preparationCreatedAt') IS typeof(captured.preparationCreatedAt) AND captured.preparationCreatedAt IS json_extract(NEW.source,'$[1].preparationCreatedAt'))
 AND (json_type(NEW.source,'$[1].preparationDocument') IS typeof(captured.preparationDocument) AND captured.preparationDocument IS json_extract(NEW.source,'$[1].preparationDocument'))
 AND (json_type(NEW.source,'$[1].approvalId') IS typeof(captured.approvalId) AND captured.approvalId IS json_extract(NEW.source,'$[1].approvalId'))
 AND (json_type(NEW.source,'$[1].approvalPreparationId') IS typeof(captured.approvalPreparationId) AND captured.approvalPreparationId IS json_extract(NEW.source,'$[1].approvalPreparationId'))
 AND (json_type(NEW.source,'$[1].approvalWallet') IS typeof(captured.approvalWallet) AND captured.approvalWallet IS json_extract(NEW.source,'$[1].approvalWallet'))
 AND (json_type(NEW.source,'$[1].approvalSignature') IS typeof(captured.approvalSignature) AND captured.approvalSignature IS json_extract(NEW.source,'$[1].approvalSignature'))
 AND (json_type(NEW.source,'$[1].approvalState') IS typeof(captured.approvalState) AND captured.approvalState IS json_extract(NEW.source,'$[1].approvalState'))
 AND (json_type(NEW.source,'$[1].approvalDocument') IS typeof(captured.approvalDocument) AND captured.approvalDocument IS json_extract(NEW.source,'$[1].approvalDocument')))))
 THEN RAISE(ABORT,'Verified settlement source changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_settlements_no_update BEFORE UPDATE ON wallet_warmup_session_settlements BEGIN SELECT RAISE(ABORT,'Verified settlement records are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_settlements_no_delete BEFORE DELETE ON wallet_warmup_session_settlements BEGIN SELECT RAISE(ABORT,'Verified settlement records are immutable'); END;
--> statement-breakpoint
DROP TRIGGER wallet_warmup_session_journal_events_insert;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_journal_events_insert BEFORE INSERT ON wallet_warmup_session_journal_events BEGIN
 SELECT CASE WHEN length(NEW.id)!=36 OR NEW.id GLOB '*[^a-f0-9-]*' OR length(replace(NEW.id,'-',''))!=32
 OR substr(NEW.id,9,1)!='-' OR substr(NEW.id,14,1)!='-' OR substr(NEW.id,19,1)!='-' OR substr(NEW.id,24,1)!='-'
 OR typeof(NEW.version)!='integer' OR NEW.version NOT BETWEEN 1 AND 4096
 OR length(NEW.event_sha256)!=64 OR NEW.event_sha256 GLOB '*[^a-f0-9]*'
 OR length(CAST(NEW.document AS BLOB))>1048576
 OR json_type(NEW.document,'$.version') IS NOT 'integer' OR json_extract(NEW.document,'$.version') IS NOT NEW.version
 OR json_extract(NEW.document,'$.eventId') IS NOT NEW.id
 OR json_extract(NEW.document,'$.previousSha256') IS NOT NEW.previous_sha256
 OR json_extract(NEW.document,'$.at') IS NOT NEW.created_at
 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) IS NOT NEW.created_at
 OR json_extract(NEW.document,'$.operation') IS NULL
 OR json_extract(NEW.document,'$.operation') NOT IN ('begin-review','submitted','unknown','pause','resume','stop','finalized')
 OR (SELECT count(*) FROM json_each(NEW.document))!= CASE WHEN json_extract(NEW.document,'$.operation')='finalized' THEN 8 WHEN json_extract(NEW.document,'$.operation')='unknown' AND json_type(NEW.document,'$.proofSha256') IS NOT NULL THEN 7 WHEN json_extract(NEW.document,'$.operation') IN ('begin-review','submitted','unknown') THEN 6 ELSE 5 END
 OR (json_extract(NEW.document,'$.operation') IN ('begin-review','submitted','unknown') AND (json_type(NEW.document,'$.actionId') IS NOT 'text' OR length(json_extract(NEW.document,'$.actionId')) NOT BETWEEN 1 AND 1024))
 OR ((json_extract(NEW.document,'$.operation')='finalized' OR json_type(NEW.document,'$.proofSha256') IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM wallet_warmup_session_settlements p WHERE p.owner_id=NEW.owner_id AND p.id=NEW.id AND p.journal_id=NEW.journal_id AND p.mode= CASE WHEN json_extract(NEW.document,'$.operation')='finalized' THEN 'applied' WHEN json_extract(NEW.document,'$.operation')='unknown' THEN 'held' ELSE '' END AND p.event_document=NEW.document AND p.event_sha256=NEW.event_sha256 AND p.record_sha256=json_extract(NEW.document,'$.proofSha256')))
 OR EXISTS(SELECT 1 FROM wallet_warmup_session_journal_events WHERE owner_id=NEW.owner_id AND id=NEW.id)
 OR (json_extract(NEW.document,'$.operation')='begin-review' AND NOT EXISTS(SELECT 1 FROM wallet_warmup_session_journals j WHERE j.owner_id=NEW.owner_id AND j.id=NEW.journal_id AND NEW.created_at<json_extract(j.source_document,'$.reviewExpiresAt') AND julianday('now')<julianday(json_extract(j.source_document,'$.reviewExpiresAt'))))
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_session_journals j JOIN wallet_warmup_session_journal_heads h ON h.owner_id=j.owner_id AND h.journal_id=j.id WHERE j.owner_id=NEW.owner_id AND j.id=NEW.journal_id
 AND NEW.version=h.version+1 AND NEW.previous_sha256=h.head_sha256
 AND NEW.version=1+COALESCE((SELECT max(e.version) FROM wallet_warmup_session_journal_events e WHERE e.owner_id=NEW.owner_id AND e.journal_id=NEW.journal_id),0)
 AND NEW.previous_sha256=COALESCE((SELECT e.event_sha256 FROM wallet_warmup_session_journal_events e WHERE e.owner_id=NEW.owner_id AND e.journal_id=NEW.journal_id ORDER BY e.version DESC LIMIT 1),j.initial_sha256)
 AND NEW.created_at>=COALESCE((SELECT e.created_at FROM wallet_warmup_session_journal_events e WHERE e.owner_id=NEW.owner_id AND e.journal_id=NEW.journal_id ORDER BY e.version DESC LIMIT 1),j.started_at)
 AND length(CAST(j.source_document AS BLOB))+length(CAST(NEW.document AS BLOB))+COALESCE((SELECT sum(length(CAST(e.document AS BLOB))) FROM wallet_warmup_session_journal_events e WHERE e.owner_id=NEW.owner_id AND e.journal_id=NEW.journal_id),0)<=4194304)
 THEN RAISE(ABORT,'Warmup journal predecessor changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_settlements_apply AFTER INSERT ON wallet_warmup_session_settlements BEGIN
 INSERT INTO wallet_warmup_session_journal_events(owner_id,journal_id,id,version,previous_sha256,document,event_sha256,created_at)
 VALUES(NEW.owner_id,NEW.journal_id,NEW.id,json_extract(NEW.document,'$.version')+1,json_extract(NEW.document,'$.headSha256'),NEW.event_document,NEW.event_sha256,NEW.created_at);
END;
