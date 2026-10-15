CREATE TABLE `pump_group_signatures` (
	`review_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`context_sha256` text NOT NULL,
	`manifest_sha256` text NOT NULL,
	`signed_group_sha256` text NOT NULL,
	`signature` text NOT NULL,
	`signed` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `pump_launch_reviews`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pump_group_signature_owner` ON `pump_group_signatures` (`owner_id`,`review_id`);
--> statement-breakpoint
CREATE TRIGGER pump_group_signature_insert BEFORE INSERT ON pump_group_signatures BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pump_launch_reviews r JOIN pump_group_approvals a ON a.review_id=r.id AND a.owner_id=r.owner_id
 WHERE r.id=NEW.review_id AND r.owner_id=NEW.owner_id AND r.state='approved' AND r.signed IS NULL AND r.signature IS NULL AND r.receipt IS NULL
 AND json_extract(r.review,'$.format')='pump-launch-group-review-v1' AND json_extract(r.review,'$.contextSha256')=NEW.context_sha256
 AND json_extract(r.review,'$.manifestSha256')=NEW.manifest_sha256 AND a.context_sha256=NEW.context_sha256 AND a.manifest_sha256=NEW.manifest_sha256)
 OR json_extract(NEW.signed,'$.format') IS NOT 'pump-launch-group-signed-evidence-v1'
 OR json_extract(NEW.signed,'$.reviewId') IS NOT NEW.review_id OR json_extract(NEW.signed,'$.contextSha256') IS NOT NEW.context_sha256
 OR json_extract(NEW.signed,'$.manifestSha256') IS NOT NEW.manifest_sha256 OR json_extract(NEW.signed,'$.signedGroupSha256') IS NOT NEW.signed_group_sha256
 OR json_extract(NEW.signed,'$.signatureSetVerified') IS NOT 1 OR json_extract(NEW.signed,'$.signingAllowed') IS NOT 0
 OR json_extract(NEW.signed,'$.executionAllowed') IS NOT 0 OR json_extract(NEW.signed,'$.completeLaunch') IS NOT 0
 OR json_extract(NEW.signed,'$.packets[0].signature') IS NOT NEW.signature
 OR json_type(NEW.signed,'$.packets') IS NOT 'array' OR json_array_length(NEW.signed,'$.packets') NOT BETWEEN 1 AND 5
 OR json_array_length(NEW.signed,'$.packets') IS NOT (SELECT json_array_length(review,'$.packets') FROM pump_launch_reviews WHERE id=NEW.review_id AND owner_id=NEW.owner_id)
 OR julianday(NEW.created_at) IS NULL OR abs(julianday('now')-julianday(NEW.created_at))>5.0/86400
 THEN RAISE(ABORT,'Complete approved signed group evidence required') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pump_launch_reviews r,json_each(NEW.signed,'$.packets') p WHERE r.id=NEW.review_id AND r.owner_id=NEW.owner_id
 AND (json_extract(p.value,'$.index') IS NOT CAST(p.key AS INTEGER)
 OR json_extract(p.value,'$.unsignedPacketSha256') IS NOT json_extract(r.review,'$.packets['||p.key||'].sha256')
 OR json_type(p.value,'$.transaction') IS NOT 'text' OR length(json_extract(p.value,'$.transaction')) NOT BETWEEN 1 AND 5464
 OR json_type(p.value,'$.signature') IS NOT 'text')) THEN RAISE(ABORT,'Signed group packet order or scope differs') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_group_signature_no_update BEFORE UPDATE ON pump_group_signatures BEGIN SELECT RAISE(ABORT,'Immutable signed group'); END;
--> statement-breakpoint
CREATE TRIGGER pump_group_signature_no_delete BEFORE DELETE ON pump_group_signatures BEGIN SELECT RAISE(ABORT,'Signed group history retained'); END;
--> statement-breakpoint
CREATE TRIGGER pump_group_signature_apply AFTER INSERT ON pump_group_signatures BEGIN
 UPDATE pump_launch_reviews SET state='signed',signed=NEW.signed,signature=NEW.signature WHERE id=NEW.review_id AND owner_id=NEW.owner_id AND state='approved';
 SELECT CASE WHEN (SELECT state FROM pump_launch_reviews WHERE id=NEW.review_id AND owner_id=NEW.owner_id) IS NOT 'signed'
 THEN RAISE(ABORT,'Group signature transition changed') END;
END;
--> statement-breakpoint
DROP TRIGGER pump_group_stage_guard;
--> statement-breakpoint
CREATE TRIGGER pump_group_stage_guard BEFORE UPDATE ON pump_launch_reviews
WHEN json_extract(OLD.review,'$.format')='pump-launch-group-review-v1' BEGIN
 SELECT CASE WHEN NOT ((OLD.state='review' AND NEW.state IN ('approved','cancelled') AND NEW.signed IS NULL AND NEW.signature IS NULL AND NEW.receipt IS NULL) OR (OLD.state='approved' AND NEW.state='signed' AND NEW.receipt IS NULL AND EXISTS(SELECT 1 FROM pump_group_signatures s WHERE s.review_id=NEW.id AND s.owner_id=NEW.owner_id AND s.signed=NEW.signed AND s.signature=NEW.signature)))
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
