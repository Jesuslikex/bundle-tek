CREATE TABLE pump_group_broadcast_reviews(id TEXT PRIMARY KEY NOT NULL,review_id TEXT NOT NULL UNIQUE REFERENCES pump_launch_reviews(id),owner_id TEXT NOT NULL,context_sha256 TEXT NOT NULL,signed_group_sha256 TEXT NOT NULL,sha256 TEXT NOT NULL,review TEXT NOT NULL,code TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE pump_group_broadcast_tips(review_id TEXT PRIMARY KEY NOT NULL REFERENCES pump_launch_reviews(id),broadcast_id TEXT NOT NULL UNIQUE REFERENCES pump_group_broadcast_reviews(id),owner_id TEXT NOT NULL,transaction_bytes TEXT NOT NULL,signature TEXT NOT NULL,sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE pump_group_broadcast_attempts(review_id TEXT PRIMARY KEY NOT NULL REFERENCES pump_launch_reviews(id),broadcast_id TEXT NOT NULL UNIQUE REFERENCES pump_group_broadcast_reviews(id),owner_id TEXT NOT NULL,consent TEXT NOT NULL,evidence TEXT NOT NULL,created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE pump_group_broadcast_results(review_id TEXT PRIMARY KEY NOT NULL REFERENCES pump_group_broadcast_attempts(review_id),owner_id TEXT NOT NULL,bundle_id TEXT,outcome TEXT NOT NULL,created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE pump_group_broadcast_observations(id TEXT PRIMARY KEY NOT NULL,review_id TEXT NOT NULL REFERENCES pump_launch_reviews(id),broadcast_id TEXT NOT NULL REFERENCES pump_group_broadcast_reviews(id),owner_id TEXT NOT NULL,observation TEXT NOT NULL,sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE INDEX pump_group_broadcast_observation_owner ON pump_group_broadcast_observations(owner_id,review_id,created_at,id);
--> statement-breakpoint
CREATE TABLE pump_group_broadcast_closures(review_id TEXT PRIMARY KEY NOT NULL REFERENCES pump_launch_reviews(id),owner_id TEXT NOT NULL,observation_id TEXT NOT NULL UNIQUE REFERENCES pump_group_broadcast_observations(id),receipt TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TRIGGER pump_group_broadcast_reviews_no_update BEFORE UPDATE ON pump_group_broadcast_reviews BEGIN SELECT RAISE(ABORT,'Immutable group broadcast history'); END;
--> statement-breakpoint
CREATE TRIGGER pump_group_broadcast_reviews_no_delete BEFORE DELETE ON pump_group_broadcast_reviews BEGIN SELECT RAISE(ABORT,'Group broadcast history retained'); END;
--> statement-breakpoint
CREATE TRIGGER pump_group_broadcast_tips_no_update BEFORE UPDATE ON pump_group_broadcast_tips BEGIN SELECT RAISE(ABORT,'Immutable group broadcast history'); END;
--> statement-breakpoint
CREATE TRIGGER pump_group_broadcast_tips_no_delete BEFORE DELETE ON pump_group_broadcast_tips BEGIN SELECT RAISE(ABORT,'Group broadcast history retained'); END;
--> statement-breakpoint
CREATE TRIGGER pump_group_broadcast_attempts_no_update BEFORE UPDATE ON pump_group_broadcast_attempts BEGIN SELECT RAISE(ABORT,'Immutable group broadcast history'); END;
--> statement-breakpoint
CREATE TRIGGER pump_group_broadcast_attempts_no_delete BEFORE DELETE ON pump_group_broadcast_attempts BEGIN SELECT RAISE(ABORT,'Group broadcast history retained'); END;
--> statement-breakpoint
CREATE TRIGGER pump_group_broadcast_results_no_update BEFORE UPDATE ON pump_group_broadcast_results BEGIN SELECT RAISE(ABORT,'Immutable group broadcast history'); END;
--> statement-breakpoint
CREATE TRIGGER pump_group_broadcast_results_no_delete BEFORE DELETE ON pump_group_broadcast_results BEGIN SELECT RAISE(ABORT,'Group broadcast history retained'); END;
--> statement-breakpoint
CREATE TRIGGER pump_group_broadcast_observations_no_update BEFORE UPDATE ON pump_group_broadcast_observations BEGIN SELECT RAISE(ABORT,'Immutable group broadcast history'); END;
--> statement-breakpoint
CREATE TRIGGER pump_group_broadcast_observations_no_delete BEFORE DELETE ON pump_group_broadcast_observations BEGIN SELECT RAISE(ABORT,'Group broadcast history retained'); END;
--> statement-breakpoint
CREATE TRIGGER pump_group_broadcast_closures_no_update BEFORE UPDATE ON pump_group_broadcast_closures BEGIN SELECT RAISE(ABORT,'Immutable group broadcast history'); END;
--> statement-breakpoint
CREATE TRIGGER pump_group_broadcast_closures_no_delete BEFORE DELETE ON pump_group_broadcast_closures BEGIN SELECT RAISE(ABORT,'Group broadcast history retained'); END;
--> statement-breakpoint
CREATE TRIGGER pump_group_broadcast_review_insert BEFORE INSERT ON pump_group_broadcast_reviews BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pump_launch_reviews r JOIN workspace_projects p ON p.owner_id=r.owner_id AND p.id=r.project_id
 WHERE r.id=NEW.review_id AND r.owner_id=NEW.owner_id AND r.state='signed' AND r.receipt IS NULL
 AND json_extract(r.review,'$.format')='pump-launch-group-review-v1' AND json_extract(r.review,'$.contextSha256')=NEW.context_sha256 AND json_extract(r.signed,'$.signedGroupSha256')=NEW.signed_group_sha256
 AND p.archived=0 AND p.document=r.project_document AND p.updated_at=json_extract(r.terms,'$.updatedAt')
 AND json_extract(NEW.review,'$.format')='pump-group-jito-broadcast-v1' AND json_extract(NEW.review,'$.id')=NEW.id AND json_extract(NEW.review,'$.reviewId')=r.id
 AND json_extract(NEW.review,'$.contextSha256')=NEW.context_sha256 AND json_extract(NEW.review,'$.signedGroupSha256')=NEW.signed_group_sha256 AND json_extract(NEW.review,'$.sha256')=NEW.sha256
 AND json_extract(NEW.review,'$.payer')=r.payer AND json_extract(NEW.review,'$.blockhash')=json_extract(r.review,'$.input.create.blockhash') AND json_extract(NEW.review,'$.lastValidBlockHeight')=json_extract(r.review,'$.input.create.lastValidBlockHeight')
 AND json_extract(NEW.review,'$.expiresAt')=r.expires_at AND NEW.expires_at=r.expires_at AND json_extract(NEW.review,'$.createdAt')=NEW.created_at
 AND json_extract(NEW.review,'$.recipient') IN ('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5','HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe','Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY','ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49','DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh','ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt','DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL','3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT')
 AND json_extract(NEW.review,'$.endpoint')='https://mainnet.block-engine.jito.wtf/api/v1/bundles' AND json_array_length(NEW.review,'$.transactions') BETWEEN 1 AND 4
 AND json_array_length(NEW.review,'$.transactions')=json_array_length(r.signed,'$.packets') AND json_extract(NEW.review,'$.executionAllowed')=0 AND json_extract(NEW.review,'$.completeLaunch')=0
 AND json_extract(NEW.review,'$.codeIdentitySha256')=json_extract(NEW.code,'$.identitySha256') AND json_extract(NEW.code,'$.reviewId')=r.id AND json_extract(NEW.code,'$.contextSha256')=NEW.context_sha256
 AND EXISTS(SELECT 1 FROM pump_group_signing_authorizations a WHERE a.review_id=r.id AND a.owner_id=r.owner_id AND a.identity_sha256=json_extract(NEW.code,'$.identitySha256'))
 AND julianday(NEW.expires_at)>julianday('now') AND julianday('now')-julianday(NEW.created_at) BETWEEN 0 AND 5.0/86400)
 THEN RAISE(ABORT,'Exact owned signed group and approved code required for broadcast review') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pump_launch_reviews r,json_each(NEW.review,'$.transactions') t WHERE r.id=NEW.review_id AND t.value IS NOT json_extract(r.signed,'$.packets['||t.key||'].transaction')) THEN RAISE(ABORT,'Every signed launch packet must be retained') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_group_broadcast_tip_insert BEFORE INSERT ON pump_group_broadcast_tips BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pump_group_broadcast_reviews b JOIN pump_launch_reviews r ON r.id=b.review_id AND r.owner_id=b.owner_id
 WHERE b.review_id=NEW.review_id AND b.id=NEW.broadcast_id AND b.owner_id=NEW.owner_id AND r.state='signed' AND r.receipt IS NULL AND json_extract(r.signed,'$.signedGroupSha256')=b.signed_group_sha256 AND NOT EXISTS(SELECT 1 FROM pump_group_broadcast_attempts WHERE review_id=r.id)) THEN RAISE(ABORT,'Exact unattempted signed group required for tip retention') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_group_broadcast_attempt_insert BEFORE INSERT ON pump_group_broadcast_attempts BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pump_group_broadcast_reviews b JOIN pump_launch_reviews r ON r.id=b.review_id AND r.owner_id=b.owner_id JOIN pump_group_broadcast_tips t ON t.review_id=b.review_id AND t.broadcast_id=b.id AND t.owner_id=b.owner_id JOIN workspace_projects p ON p.owner_id=r.owner_id AND p.id=r.project_id
 WHERE b.review_id=NEW.review_id AND b.id=NEW.broadcast_id AND b.owner_id=NEW.owner_id AND r.state='signed' AND r.receipt IS NULL AND json_extract(r.signed,'$.signedGroupSha256')=b.signed_group_sha256 AND json_extract(r.review,'$.contextSha256')=b.context_sha256
 AND p.archived=0 AND p.document=r.project_document AND p.updated_at=json_extract(r.terms,'$.updatedAt')
 AND json_extract(NEW.consent,'$.approved')=1 AND json_extract(NEW.consent,'$.scope')='one-attempt-jito-complete-group-and-tip' AND json_extract(NEW.consent,'$.acknowledgeUncertainOutcome')=1
 AND json_extract(NEW.consent,'$.reviewId')=r.id AND json_extract(NEW.consent,'$.broadcastId')=b.id AND json_extract(NEW.consent,'$.broadcastSha256')=b.sha256 AND json_extract(NEW.consent,'$.signedGroupSha256')=b.signed_group_sha256
 AND json_extract(NEW.evidence,'$.broadcastSha256')=b.sha256 AND json_extract(NEW.evidence,'$.tipSha256')=t.sha256 AND json_extract(NEW.evidence,'$.codeIdentitySha256')=json_extract(b.review,'$.codeIdentitySha256') AND json_extract(NEW.evidence,'$.fullCodeRechecked')=1
 AND json_extract(NEW.evidence,'$.simulation.expiresAt')=b.expires_at AND CAST(json_extract(NEW.evidence,'$.simulation.tipFeeRaw') AS INTEGER) BETWEEN 1 AND CAST(json_extract(b.review,'$.tipFeeLimitRaw') AS INTEGER)
 AND julianday(b.expires_at)>julianday('now') AND julianday('now')-julianday(NEW.created_at) BETWEEN 0 AND 5.0/86400)
 THEN RAISE(ABORT,'Exact fresh approved one-attempt broadcast required') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pump_launch_reviews r JOIN workspace_wallets w ON w.owner_id=r.owner_id AND w.address=r.payer JOIN wallet_ownership_proofs o ON o.owner_id=w.owner_id AND o.chain=w.chain AND o.address=w.address
 WHERE r.id=NEW.review_id AND w.chain='Solana' AND w.role='Deployer' AND w.archived=0 AND w.revision=json_extract(r.terms,'$.payerRevision')
 AND (json_extract(r.project_document,'$.options.wallets.deployer.root')=1 OR (json_extract(r.project_document,'$.options.wallets.deployer.folderRevision')=0 AND json_extract(r.project_document,'$.options.wallets.deployer.folderId') IS NULL AND COALESCE(w.folder_ids,CASE WHEN w.folder_id='' THEN '[]' ELSE json_array(w.folder_id) END)='[]') OR EXISTS(SELECT 1 FROM wallet_folders f WHERE f.owner_id=w.owner_id AND f.chain='Solana' AND f.archived=0 AND f.id=COALESCE(json_extract(r.project_document,'$.options.wallets.deployer.folderId'),w.folder_id) AND f.revision=json_extract(r.project_document,'$.options.wallets.deployer.folderRevision') AND EXISTS(SELECT 1 FROM json_each(COALESCE(w.folder_ids,json_array(w.folder_id))) WHERE value=f.id))))
 THEN RAISE(ABORT,'Runtime deployer ownership changed') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pump_launch_reviews r,json_each(r.project_document,'$.options.wallets.recipients') ref WHERE r.id=NEW.review_id AND r.owner_id=NEW.owner_id AND NOT EXISTS(SELECT 1 FROM workspace_wallets w JOIN wallet_ownership_proofs o ON o.owner_id=w.owner_id AND o.chain=w.chain AND o.address=w.address WHERE w.owner_id=r.owner_id AND w.chain='Solana' AND w.role='Recipient' AND w.archived=0 AND w.address=json_extract(ref.value,'$.address') AND w.revision=json_extract(ref.value,'$.revision') AND (json_extract(ref.value,'$.root')=1 OR (json_extract(ref.value,'$.folderRevision')=0 AND json_extract(ref.value,'$.folderId') IS NULL AND COALESCE(w.folder_ids,CASE WHEN w.folder_id='' THEN '[]' ELSE json_array(w.folder_id) END)='[]') OR EXISTS(SELECT 1 FROM wallet_folders f WHERE f.owner_id=w.owner_id AND f.chain='Solana' AND f.archived=0 AND f.id=COALESCE(json_extract(ref.value,'$.folderId'),w.folder_id) AND f.revision=json_extract(ref.value,'$.folderRevision') AND EXISTS(SELECT 1 FROM json_each(COALESCE(w.folder_ids,json_array(w.folder_id))) WHERE value=f.id)))))
 THEN RAISE(ABORT,'Runtime holder ownership changed') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pump_launch_reviews r JOIN launch_metadata_releases m ON m.owner_id=r.owner_id AND m.project_id=r.project_id AND m.id=json_extract(r.terms,'$.releaseId') WHERE r.id=NEW.review_id AND r.owner_id=NEW.owner_id) THEN RAISE(ABORT,'Runtime metadata release changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_group_broadcast_result_insert BEFORE INSERT ON pump_group_broadcast_results BEGIN
 SELECT CASE WHEN NEW.outcome NOT IN ('accepted','unknown') OR NOT EXISTS(SELECT 1 FROM pump_group_broadcast_attempts a WHERE a.review_id=NEW.review_id AND a.owner_id=NEW.owner_id) OR (NEW.outcome='accepted' AND (length(NEW.bundle_id)!=64 OR NEW.bundle_id GLOB '*[^a-f0-9]*')) OR (NEW.outcome='unknown' AND NEW.bundle_id IS NOT NULL) THEN RAISE(ABORT,'Exact attempted broadcast result required') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_group_broadcast_observation_insert BEFORE INSERT ON pump_group_broadcast_observations BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pump_group_broadcast_reviews b JOIN pump_group_observations g ON g.review_id=b.review_id AND g.owner_id=b.owner_id
 WHERE b.review_id=NEW.review_id AND b.id=NEW.broadcast_id AND b.owner_id=NEW.owner_id AND g.id=json_extract(NEW.observation,'$.groupObservationId') AND g.sha256=json_extract(NEW.observation,'$.groupObservationSha256')
 AND json_extract(NEW.observation,'$.format')='pump-group-jito-recovery-v1' AND json_extract(NEW.observation,'$.id')=NEW.id AND json_extract(NEW.observation,'$.reviewId')=b.review_id AND json_extract(NEW.observation,'$.broadcastId')=b.id AND json_extract(NEW.observation,'$.broadcastSha256')=b.sha256
 AND json_extract(NEW.observation,'$.signedGroupSha256')=b.signed_group_sha256 AND json_extract(NEW.observation,'$.sha256')=NEW.sha256 AND json_extract(NEW.observation,'$.observedAt')=NEW.created_at
 AND json_extract(NEW.observation,'$.economicSettlementVerified')=0 AND json_extract(NEW.observation,'$.completeLaunch')=0
 AND json_extract(NEW.observation,'$.tip.signature') IS (SELECT signature FROM pump_group_broadcast_tips t WHERE t.review_id=b.review_id AND t.broadcast_id=b.id AND t.owner_id=b.owner_id)
 AND ((json_extract(NEW.observation,'$.tip.finalized')=0 AND json_extract(NEW.observation,'$.tip.succeeded') IS NULL AND json_extract(NEW.observation,'$.tip.slot') IS NULL AND json_extract(NEW.observation,'$.tip.networkFeeRaw') IS NULL AND json_extract(NEW.observation,'$.tip.tipDebitRaw') IS NULL)
 OR (json_extract(NEW.observation,'$.tip.finalized')=1 AND json_extract(NEW.observation,'$.tip.succeeded') IN (0,1) AND CAST(json_extract(NEW.observation,'$.tip.slot') AS INTEGER)>0
 AND CAST(json_extract(NEW.observation,'$.tip.networkFeeRaw') AS INTEGER) BETWEEN 1 AND CAST(json_extract(b.review,'$.tipFeeLimitRaw') AS INTEGER)
 AND json_extract(NEW.observation,'$.tip.tipDebitRaw')= CASE json_extract(NEW.observation,'$.tip.succeeded') WHEN 1 THEN json_extract(b.review,'$.tipRaw') ELSE '0' END
 AND EXISTS(SELECT 1 FROM pump_group_broadcast_tips t WHERE t.review_id=b.review_id AND t.owner_id=b.owner_id AND t.broadcast_id=b.id AND t.signature=json_extract(NEW.observation,'$.tip.signature'))))
 AND julianday('now')-julianday(g.created_at) BETWEEN 0 AND 10.0/86400 AND julianday('now')-julianday(NEW.created_at) BETWEEN 0 AND 5.0/86400)
 THEN RAISE(ABORT,'Fresh linked complete group and tip observation required') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_group_broadcast_closure_insert BEFORE INSERT ON pump_group_broadcast_closures BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pump_group_broadcast_observations o JOIN pump_group_broadcast_reviews b ON b.id=o.broadcast_id AND b.owner_id=o.owner_id JOIN pump_launch_reviews r ON r.id=b.review_id AND r.owner_id=b.owner_id JOIN pump_group_observations g ON g.id=json_extract(o.observation,'$.groupObservationId') AND g.owner_id=o.owner_id
 WHERE o.id=NEW.observation_id AND o.review_id=NEW.review_id AND o.owner_id=NEW.owner_id AND r.state='signed' AND r.receipt IS NULL
 AND json_extract(r.signed,'$.signedGroupSha256')=b.signed_group_sha256 AND json_extract(NEW.receipt,'$.format')='pump-launch-group-broadcast-terminal-v1' AND json_extract(NEW.receipt,'$.reviewId')=r.id AND json_extract(NEW.receipt,'$.contextSha256')=b.context_sha256
 AND json_extract(NEW.receipt,'$.broadcastSha256')=b.sha256 AND json_extract(NEW.receipt,'$.signedGroupSha256')=b.signed_group_sha256 AND json_extract(NEW.receipt,'$.observationId')=o.id AND json_extract(NEW.receipt,'$.observationSha256')=o.sha256
 AND json_extract(NEW.receipt,'$.kind')= CASE NEW.state WHEN 'cancelled' THEN 'expired-unobserved' ELSE NEW.state END
 AND json_extract(NEW.receipt,'$.sourceState')='signed' AND json_extract(NEW.receipt,'$.manifestSha256')=json_extract(r.review,'$.manifestSha256') AND json_extract(NEW.receipt,'$.broadcastId')=b.id AND json_extract(NEW.receipt,'$.observedAt')=o.created_at
 AND json_extract(NEW.receipt,'$.groupNetworkFeeRaw')=json_extract(g.observation,'$.receipt.knownNetworkFeeRaw')
 AND json_extract(NEW.receipt,'$.tipNetworkFeeRaw') IS json_extract(o.observation,'$.tip.networkFeeRaw') AND json_extract(NEW.receipt,'$.tipDebitRaw') IS json_extract(o.observation,'$.tip.tipDebitRaw')
 AND CAST(json_extract(NEW.receipt,'$.knownNetworkFeeRaw') AS INTEGER)=CAST(json_extract(g.observation,'$.receipt.knownNetworkFeeRaw') AS INTEGER)+COALESCE(CAST(json_extract(o.observation,'$.tip.networkFeeRaw') AS INTEGER),0)
 AND json_extract(NEW.receipt,'$.networkFeeUnresolved')= CASE WHEN json_extract(g.observation,'$.receipt.networkFeeUnresolved')=1 OR json_extract(o.observation,'$.tip.networkFeeRaw') IS NULL THEN 1 ELSE 0 END
 AND json_extract(NEW.receipt,'$.reservationsReleased')=1 AND json_extract(NEW.receipt,'$.economicSettlementVerified')=0 AND json_extract(NEW.receipt,'$.completeLaunch')=0 AND json_extract(NEW.receipt,'$.signingAllowed')=0 AND json_extract(NEW.receipt,'$.executionAllowed')=0
 AND julianday('now')-julianday(o.created_at) BETWEEN 0 AND 5.0/86400 AND julianday('now')-julianday(NEW.created_at) BETWEEN 0 AND 5.0/86400
 AND ((NEW.state='finalized' AND g.observed_state='complete' AND json_extract(g.observation,'$.receipt.networkFeeUnresolved')=0 AND json_extract(o.observation,'$.state')='finalized' AND json_extract(o.observation,'$.tip.finalized')=1 AND json_extract(o.observation,'$.tip.succeeded')=1 AND json_extract(o.observation,'$.tip.networkFeeRaw') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM json_each(g.observation,'$.receipt.packets') packet WHERE json_extract(packet.value,'$.slot') IS NOT json_extract(o.observation,'$.tip.slot') OR json_extract(packet.value,'$.finalized') IS NOT 1 OR json_extract(packet.value,'$.succeeded') IS NOT 1 OR json_extract(packet.value,'$.networkFeeRaw') IS NULL))
 OR (NEW.state='failed' AND g.observed_state='failed' AND json_extract(g.observation,'$.receipt.networkFeeUnresolved')=0 AND json_extract(o.observation,'$.state')='failed' AND json_extract(o.observation,'$.tip.finalized')=1 AND json_extract(o.observation,'$.tip.succeeded')=0 AND json_extract(o.observation,'$.tip.networkFeeRaw') IS NOT NULL)
 OR (NEW.state='cancelled' AND g.observed_state='expired-unobserved' AND json_extract(o.observation,'$.state')='expired-unobserved' AND json_extract(g.observation,'$.receipt.observedPacketCount')=0 AND json_extract(g.observation,'$.receipt.expiry.pastExpiryMargin')=1 AND json_extract(g.observation,'$.receipt.expiry.mintAbsent')=1 AND json_extract(g.observation,'$.receipt.expiry.marginBlocks')=32
 AND json_extract(g.observation,'$.receipt.expiry.lastValidBlockHeight')=json_extract(b.review,'$.lastValidBlockHeight')
 AND CAST(json_extract(g.observation,'$.receipt.expiry.finalizedBlockHeight') AS INTEGER)>CAST(json_extract(b.review,'$.lastValidBlockHeight') AS INTEGER)+32
 AND CAST(json_extract(g.observation,'$.receipt.expiry.mintObservedSlot') AS INTEGER)>=CAST(json_extract(g.observation,'$.receipt.expiry.expiryBankSlot') AS INTEGER)
 AND json_extract(o.observation,'$.tip.finalized')=0 AND json_extract(o.observation,'$.tip.slot') IS NULL)))
 THEN RAISE(ABORT,'Exact finalized or expired complete group and tip proof required') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_group_broadcast_closure_apply AFTER INSERT ON pump_group_broadcast_closures BEGIN
 UPDATE pump_launch_reviews SET state=NEW.state,receipt=NEW.receipt WHERE owner_id=NEW.owner_id AND id=NEW.review_id AND state='signed' AND receipt IS NULL;
 SELECT CASE WHEN (SELECT state FROM pump_launch_reviews WHERE id=NEW.review_id AND owner_id=NEW.owner_id) IS NOT NEW.state THEN RAISE(ABORT,'Broadcast closure transition changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_group_terminal_broadcast_guard BEFORE INSERT ON pump_group_terminal_recoveries WHEN EXISTS(SELECT 1 FROM pump_group_broadcast_reviews b WHERE b.review_id=NEW.review_id AND b.owner_id=NEW.owner_id) BEGIN SELECT RAISE(ABORT,'Recover the complete broadcast including its tip'); END;
--> statement-breakpoint
DROP TRIGGER pump_group_stage_guard;
--> statement-breakpoint
CREATE TRIGGER pump_group_stage_guard BEFORE UPDATE ON pump_launch_reviews
WHEN json_extract(OLD.review,'$.format')='pump-launch-group-review-v1' BEGIN
 SELECT CASE WHEN NOT ((OLD.state='review' AND NEW.state IN ('approved','cancelled') AND NEW.signed IS NULL AND NEW.signature IS NULL AND NEW.receipt IS NULL) OR (OLD.state='approved' AND NEW.state='signed' AND NEW.receipt IS NULL AND EXISTS(SELECT 1 FROM pump_group_signatures s WHERE s.review_id=NEW.id AND s.owner_id=NEW.owner_id AND s.signed=NEW.signed AND s.signature=NEW.signature)))
 AND NOT (OLD.state IN ('approved','signed') AND NEW.state= CASE json_extract(NEW.receipt,'$.kind') WHEN 'all-packets-failed' THEN 'failed' ELSE 'cancelled' END AND NEW.signed IS OLD.signed AND NEW.signature IS OLD.signature AND EXISTS(SELECT 1 FROM pump_group_terminal_recoveries t WHERE t.review_id=OLD.id AND t.owner_id=OLD.owner_id AND t.receipt=NEW.receipt)) AND NOT (OLD.state='signed' AND NEW.state IN ('finalized','failed','cancelled') AND NEW.signed IS OLD.signed AND NEW.signature IS OLD.signature AND EXISTS(SELECT 1 FROM pump_group_broadcast_closures c WHERE c.review_id=OLD.id AND c.owner_id=OLD.owner_id AND c.state=NEW.state AND c.receipt=NEW.receipt)) THEN RAISE(ABORT,'Group execution or unproven recovery is not enabled') END;
 SELECT CASE WHEN NEW.state='cancelled' AND EXISTS(SELECT 1 FROM pump_group_approvals WHERE review_id=NEW.id) AND NOT EXISTS(SELECT 1 FROM pump_group_terminal_recoveries t WHERE t.review_id=OLD.id AND t.owner_id=OLD.owner_id AND t.receipt=NEW.receipt)
 AND NOT EXISTS(SELECT 1 FROM pump_group_broadcast_closures c WHERE c.review_id=OLD.id AND c.owner_id=OLD.owner_id AND c.state=NEW.state AND c.receipt=NEW.receipt) THEN RAISE(ABORT,'Recorded group approval requires lifetime recovery') END;
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
--> statement-breakpoint
CREATE TRIGGER pump_group_shared_reservation_update BEFORE UPDATE OF owner_id,wallet_address ON solana_execution_reservations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pump_launch_reviews r WHERE r.owner_id=NEW.owner_id AND r.state NOT IN ('cancelled','failed','finalized') AND json_extract(r.review,'$.format')='pump-launch-group-review-v1'
 AND (r.payer=NEW.wallet_address OR NEW.wallet_address IN (SELECT json_extract(value,'$.address') FROM json_each(r.review,'$.input.holders') WHERE json_extract(value,'$.kind')!='none')))
 THEN RAISE(ABORT,'Wallet reserved for complete group') END;
END;
