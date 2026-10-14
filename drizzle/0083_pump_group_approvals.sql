CREATE TABLE `pump_group_approvals` (
	`review_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`context_sha256` text NOT NULL,
	`manifest_sha256` text NOT NULL,
	`simulation_sha256` text NOT NULL,
	`fresh_simulation_sha256` text NOT NULL,
	`consent` text NOT NULL,
	`fresh` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `pump_launch_reviews`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pump_group_approval_owner` ON `pump_group_approvals` (`owner_id`,`review_id`);
--> statement-breakpoint
CREATE TRIGGER pump_group_approval_insert BEFORE INSERT ON pump_group_approvals BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pump_launch_reviews r WHERE r.id=NEW.review_id AND r.owner_id=NEW.owner_id AND r.state='review'
 AND json_extract(r.review,'$.format')='pump-launch-group-review-v1' AND julianday(r.expires_at)>julianday('now')
 AND json_extract(r.review,'$.contextSha256')=NEW.context_sha256 AND json_extract(r.review,'$.manifestSha256')=NEW.manifest_sha256
 AND json_extract(r.review,'$.simulationSha256')=NEW.simulation_sha256)
 OR json_extract(NEW.consent,'$.approved') IS NOT 1 OR json_extract(NEW.consent,'$.acknowledgeSimulationLimits') IS NOT 1
 OR json_extract(NEW.consent,'$.reviewId') IS NOT NEW.review_id OR json_extract(NEW.consent,'$.contextSha256') IS NOT NEW.context_sha256
 OR json_extract(NEW.consent,'$.manifestSha256') IS NOT NEW.manifest_sha256 OR json_extract(NEW.consent,'$.simulationSha256') IS NOT NEW.simulation_sha256
 OR json_extract(NEW.consent,'$.approvedScope') IS NOT 'complete-create-developer-holder-packet-group'
 OR json_extract(NEW.fresh,'$.sourceRevalidated') IS NOT 1 OR json_extract(NEW.fresh,'$.reviewContextSha256') IS NOT NEW.context_sha256
 OR json_extract(NEW.fresh,'$.simulationSha256') IS NOT NEW.fresh_simulation_sha256
 OR json_extract(NEW.fresh,'$.checked.group.manifestSha256') IS NOT NEW.manifest_sha256
 OR json_extract(NEW.fresh,'$.checked.simulation.manifestSha256') IS NOT NEW.manifest_sha256
 OR json_extract(NEW.fresh,'$.originalReviewExpiresAt') IS NOT (SELECT expires_at FROM pump_launch_reviews WHERE id=NEW.review_id AND owner_id=NEW.owner_id)
 OR json_extract(NEW.fresh,'$.signingAllowed') IS NOT 0 OR json_extract(NEW.fresh,'$.executionAllowed') IS NOT 0
 OR julianday(json_extract(NEW.fresh,'$.checked.simulation.observedAt')) IS NULL
 OR julianday(json_extract(NEW.fresh,'$.checked.simulation.expiresAt')) IS NULL
 OR julianday(json_extract(NEW.fresh,'$.checked.simulation.expiresAt'))<=julianday('now')
 OR julianday('now')-julianday(json_extract(NEW.fresh,'$.checked.simulation.observedAt')) NOT BETWEEN 0 AND 10.0/86400
 OR julianday(NEW.created_at) IS NULL OR abs(julianday('now')-julianday(NEW.created_at))>5.0/86400
 THEN RAISE(ABORT,'Fresh exact group approval evidence required') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pump_launch_reviews r JOIN workspace_projects p ON p.owner_id=r.owner_id AND p.id=r.project_id
 JOIN workspace_wallets w ON w.owner_id=r.owner_id AND w.chain='Solana' AND w.address=r.payer
 JOIN launch_metadata_releases m ON m.owner_id=r.owner_id AND m.project_id=r.project_id AND m.id=json_extract(r.terms,'$.releaseId')
 WHERE r.id=NEW.review_id AND r.owner_id=NEW.owner_id AND p.archived=0 AND p.document=r.project_document AND p.updated_at=json_extract(r.terms,'$.updatedAt')
 AND w.role='Deployer' AND w.archived=0 AND w.revision=json_extract(r.terms,'$.payerRevision')
 AND EXISTS(SELECT 1 FROM wallet_ownership_proofs o WHERE o.owner_id=w.owner_id AND o.chain=w.chain AND o.address=w.address))
 THEN RAISE(ABORT,'Group approval project, payer or release changed') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pump_launch_reviews r,json_each(r.project_document,'$.options.wallets.recipients') ref WHERE r.id=NEW.review_id AND r.owner_id=NEW.owner_id AND NOT EXISTS(
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
CREATE TRIGGER pump_group_approval_no_update BEFORE UPDATE ON pump_group_approvals BEGIN SELECT RAISE(ABORT,'Immutable group approval'); END;
--> statement-breakpoint
CREATE TRIGGER pump_group_approval_no_delete BEFORE DELETE ON pump_group_approvals BEGIN SELECT RAISE(ABORT,'Group approval history retained'); END;
--> statement-breakpoint
CREATE TRIGGER pump_group_approval_apply AFTER INSERT ON pump_group_approvals BEGIN
 UPDATE pump_launch_reviews SET state='approved' WHERE id=NEW.review_id AND owner_id=NEW.owner_id AND state='review';
 SELECT CASE WHEN (SELECT state FROM pump_launch_reviews WHERE id=NEW.review_id AND owner_id=NEW.owner_id) IS NOT 'approved'
 THEN RAISE(ABORT,'Group approval transition changed') END;
END;
--> statement-breakpoint
DROP TRIGGER pump_group_stage_guard;
--> statement-breakpoint
CREATE TRIGGER pump_group_stage_guard BEFORE UPDATE ON pump_launch_reviews
WHEN json_extract(OLD.review,'$.format')='pump-launch-group-review-v1' BEGIN
 SELECT CASE WHEN OLD.state!='review' OR NEW.state NOT IN ('approved','cancelled') OR NEW.signed IS NOT NULL OR NEW.signature IS NOT NULL OR NEW.receipt IS NOT NULL
 THEN RAISE(ABORT,'Group signing, execution and approved cancellation are not enabled') END;
 SELECT CASE WHEN NEW.state='cancelled' AND EXISTS(SELECT 1 FROM pump_group_approvals WHERE review_id=NEW.id)
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
