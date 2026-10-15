CREATE TABLE pump_group_terminal_recoveries (
 review_id TEXT PRIMARY KEY NOT NULL REFERENCES pump_launch_reviews(id),
 owner_id TEXT NOT NULL,
 observation_id TEXT NOT NULL UNIQUE REFERENCES pump_group_observations(id),
 receipt TEXT NOT NULL,
 created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER pump_group_terminal_insert BEFORE INSERT ON pump_group_terminal_recoveries BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pump_launch_reviews r JOIN pump_group_observations o ON o.review_id=r.id AND o.owner_id=r.owner_id
 WHERE r.id=NEW.review_id AND r.owner_id=NEW.owner_id AND o.id=NEW.observation_id AND r.state IN ('approved','signed') AND r.state=o.source_state AND r.receipt IS NULL
 AND json_extract(r.review,'$.format')='pump-launch-group-review-v1'
 AND o.context_sha256=json_extract(r.review,'$.contextSha256') AND o.manifest_sha256=json_extract(r.review,'$.manifestSha256')
 AND o.signed_group_sha256 IS json_extract(r.signed,'$.signedGroupSha256')
 AND json_extract(NEW.receipt,'$.format')='pump-launch-group-terminal-recovery-v1'
 AND json_extract(NEW.receipt,'$.reviewId')=r.id AND json_extract(NEW.receipt,'$.contextSha256')=o.context_sha256
 AND json_extract(NEW.receipt,'$.manifestSha256')=o.manifest_sha256 AND json_extract(NEW.receipt,'$.signedGroupSha256') IS o.signed_group_sha256
 AND json_extract(NEW.receipt,'$.observationId')=o.id AND json_extract(NEW.receipt,'$.observationSha256')=o.sha256
 AND json_extract(NEW.receipt,'$.sourceState')=o.source_state AND json_extract(NEW.receipt,'$.observedAt')=o.created_at
 AND json_extract(NEW.receipt,'$.knownNetworkFeeRaw')=json_extract(o.observation,'$.receipt.knownNetworkFeeRaw')
 AND json_extract(NEW.receipt,'$.networkFeeUnresolved')=json_extract(o.observation,'$.receipt.networkFeeUnresolved')
 AND json_extract(NEW.receipt,'$.reservationsReleased')=1 AND json_extract(NEW.receipt,'$.economicSettlementVerified')=0
 AND json_extract(NEW.receipt,'$.signingAllowed')=0 AND json_extract(NEW.receipt,'$.executionAllowed')=0 AND json_extract(NEW.receipt,'$.completeLaunch')=0
 AND julianday('now')-julianday(o.created_at) BETWEEN 0 AND 5.0/86400 AND julianday('now')-julianday(NEW.created_at) BETWEEN 0 AND 5.0/86400
 AND ((json_extract(NEW.receipt,'$.kind')='expired-unobserved' AND o.observed_state='expired-unobserved'
 AND json_extract(o.observation,'$.receipt.observedPacketCount')=0 AND json_extract(o.observation,'$.receipt.successfulPacketCount')=0
 AND json_extract(o.observation,'$.receipt.expiry.pastExpiryMargin')=1 AND json_extract(o.observation,'$.receipt.expiry.marginBlocks')=32
 AND json_extract(o.observation,'$.receipt.expiry.mintAbsent')=1
 AND json_extract(o.observation,'$.receipt.expiry.lastValidBlockHeight')=json_extract(r.review,'$.input.create.lastValidBlockHeight')
 AND CAST(json_extract(o.observation,'$.receipt.expiry.finalizedBlockHeight') AS INTEGER)>CAST(json_extract(r.review,'$.input.create.lastValidBlockHeight') AS INTEGER)+32
 AND CAST(json_extract(o.observation,'$.receipt.expiry.mintObservedSlot') AS INTEGER)>=CAST(json_extract(o.observation,'$.receipt.expiry.expiryBankSlot') AS INTEGER))
 OR (json_extract(NEW.receipt,'$.kind')='all-packets-failed' AND r.state='signed' AND o.observed_state='failed'
 AND json_extract(o.observation,'$.receipt.allPacketsFinalized')=1 AND json_extract(o.observation,'$.receipt.successfulPacketCount')=0
 AND json_extract(o.observation,'$.receipt.networkFeeUnresolved')=0 AND o.signed_group_sha256 IS NOT NULL)))
 THEN RAISE(ABORT,'Fresh exact terminal group observation required') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_group_terminal_no_update BEFORE UPDATE ON pump_group_terminal_recoveries BEGIN SELECT RAISE(ABORT,'Immutable terminal group recovery'); END;
--> statement-breakpoint
CREATE TRIGGER pump_group_terminal_no_delete BEFORE DELETE ON pump_group_terminal_recoveries BEGIN SELECT RAISE(ABORT,'Terminal group history retained'); END;
--> statement-breakpoint
CREATE TRIGGER pump_group_terminal_apply AFTER INSERT ON pump_group_terminal_recoveries BEGIN
 UPDATE pump_launch_reviews SET state= CASE json_extract(NEW.receipt,'$.kind') WHEN 'all-packets-failed' THEN 'failed' ELSE 'cancelled' END,receipt=NEW.receipt WHERE id=NEW.review_id AND owner_id=NEW.owner_id AND state IN ('approved','signed') AND receipt IS NULL;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pump_launch_reviews WHERE id=NEW.review_id AND owner_id=NEW.owner_id AND state IN ('failed','cancelled') AND receipt=NEW.receipt) THEN RAISE(ABORT,'Terminal group transition changed') END;
END;
--> statement-breakpoint
DROP TRIGGER pump_group_stage_guard;
--> statement-breakpoint
CREATE TRIGGER pump_group_stage_guard BEFORE UPDATE ON pump_launch_reviews
WHEN json_extract(OLD.review,'$.format')='pump-launch-group-review-v1' BEGIN
 SELECT CASE WHEN NOT ((OLD.state='review' AND NEW.state IN ('approved','cancelled') AND NEW.signed IS NULL AND NEW.signature IS NULL AND NEW.receipt IS NULL) OR (OLD.state='approved' AND NEW.state='signed' AND NEW.receipt IS NULL AND EXISTS(SELECT 1 FROM pump_group_signatures s WHERE s.review_id=NEW.id AND s.owner_id=NEW.owner_id AND s.signed=NEW.signed AND s.signature=NEW.signature)))
 AND NOT (OLD.state IN ('approved','signed') AND NEW.state= CASE json_extract(NEW.receipt,'$.kind') WHEN 'all-packets-failed' THEN 'failed' ELSE 'cancelled' END AND NEW.signed IS OLD.signed AND NEW.signature IS OLD.signature AND EXISTS(SELECT 1 FROM pump_group_terminal_recoveries t WHERE t.review_id=OLD.id AND t.owner_id=OLD.owner_id AND t.receipt=NEW.receipt)) THEN RAISE(ABORT,'Group execution or unproven recovery is not enabled') END;
 SELECT CASE WHEN NEW.state='cancelled' AND EXISTS(SELECT 1 FROM pump_group_approvals WHERE review_id=NEW.id) AND NOT EXISTS(SELECT 1 FROM pump_group_terminal_recoveries t WHERE t.review_id=OLD.id AND t.owner_id=OLD.owner_id AND t.receipt=NEW.receipt)
 THEN RAISE(ABORT,'Recorded group approval requires lifetime recovery') END;
 SELECT CASE WHEN NEW.state='approved' AND NOT EXISTS(SELECT 1 FROM pump_group_approvals a WHERE a.review_id=NEW.id AND a.owner_id=NEW.owner_id
 AND a.context_sha256=json_extract(NEW.review,'$.contextSha256') AND a.manifest_sha256=json_extract(NEW.review,'$.manifestSha256')
 AND a.simulation_sha256=json_extract(NEW.review,'$.simulationSha256') AND julianday('now')-julianday(a.created_at) BETWEEN 0 AND 10.0/86400)
 THEN RAISE(ABORT,'Group approval evidence missing or execution is not enabled') END;
 SELECT CASE WHEN NEW.state='approved' AND NOT EXISTS(SELECT 1 FROM workspace_wallets w JOIN wallet_ownership_proofs o ON o.owner_id=w.owner_id AND o.chain=w.chain AND o.address=w.address
 WHERE w.owner_id=NEW.owner_id AND w.chain='Solana' AND w.address=NEW.payer AND w.role='Deployer' AND w.archived=0 AND w.revision=json_extract(NEW.terms,'$.payerRevision'))
 THEN RAISE(ABORT,'Group approval payer changed') END;
 SELECT CASE WHEN NEW.state='approved' AND NOT EXISTS(SELECT 1 FROM launch_metadata_releases WHERE owner_id=NEW.owner_id AND project_id=NEW.project_id AND id=json_extract(NEW.terms,'$.releaseId'))
 THEN RAISE(ABORT,'Group approval release changed') END;
 SELECT CASE WHEN NEW.state='approved' AND EXISTS(SELECT 1 FROM pump_launch_reviews r,json_each(r.project_document,'$.options.wallets.recipients') ref WHERE r.id=NEW.id AND r.owner_id=NEW.owner_id AND NOT EXISTS(
 SELECT 1 FROM workspace_wallets w JOIN wallet_ownership_proofs o ON o.owner_id=w.owner_id AND o.chain=w.chain AND o.address=w.address
 WHERE w.owner_id=r.owner_id AND w.chain='Solana' AND w.role='Recipient' AND w.archived=0
 AND w.address=json_extract(ref.value,'$.address') AND w.revision=json_extract(ref.value,'$.revision') AND (
 json_extract(ref.value,'$.root')=1 OR
 (json_extract(ref.value,'$.folderRevision')=0 AND json_extract(ref.value,'$.folderId') IS NULL AND COALESCE(w.folder_ids, CASE WHEN w.folder_id='' THEN '[]' ELSE json_array(w.folder_id) END)='[]') OR
 EXISTS(SELECT 1 FROM wallet_folders f WHERE f.owner_id=w.owner_id AND f.chain='Solana' AND f.archived=0
 AND f.id=COALESCE(json_extract(ref.value,'$.folderId'),w.folder_id) AND f.revision=json_extract(ref.value,'$.folderRevision')
 AND EXISTS(SELECT 1 FROM json_each(COALESCE(w.folder_ids,json_array(w.folder_id))) WHERE value=f.id))
 ))) THEN RAISE(ABORT,'Holder wallet proof, role, revision or folder changed') END;
END;
