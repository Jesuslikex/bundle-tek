CREATE TRIGGER pump_group_review_insert BEFORE INSERT ON pump_launch_reviews
WHEN json_extract(NEW.review,'$.format')='pump-launch-group-review-v1' BEGIN
 SELECT CASE WHEN json_extract(NEW.review,'$.id') IS NOT NEW.id
 OR json_extract(NEW.review,'$.projectId') IS NOT NEW.project_id
 OR json_extract(NEW.review,'$.projectUpdatedAt') IS NOT json_extract(NEW.terms,'$.updatedAt')
 OR json_extract(NEW.review,'$.input.create.payer') IS NOT NEW.payer OR json_extract(NEW.review,'$.input.create.mint') IS NOT NEW.mint
 OR json_extract(NEW.review,'$.expiresAt') IS NOT NEW.expires_at
 OR json_extract(NEW.review,'$.releaseId') IS NOT json_extract(NEW.terms,'$.releaseId')
 OR json_extract(NEW.project_document,'$.options.wallets.deployer.address') IS NOT NEW.payer
 OR json_extract(NEW.project_document,'$.options.wallets.deployer.revision') IS NOT json_extract(NEW.terms,'$.payerRevision')
 OR json_extract(NEW.review,'$.document') IS NOT json(NEW.project_document)
 OR json_extract(NEW.review,'$.simulation') IS NOT json_extract(NEW.simulation,'$.simulation')
 OR json_type(NEW.review,'$.packets') IS NOT 'array' OR json_array_length(NEW.review,'$.packets') NOT BETWEEN 1 AND 5
 OR json_type(NEW.review,'$.input.holders') IS NOT 'array' OR json_array_length(NEW.review,'$.input.holders') NOT BETWEEN 1 AND 200
 OR json_array_length(NEW.review,'$.input.holders') IS NOT json_array_length(NEW.project_document,'$.options.wallets.recipients')
 OR json_extract(NEW.review,'$.manifestSha256') IS NOT json_extract(NEW.simulation,'$.group.manifestSha256')
 OR json_extract(NEW.review,'$.allowanceSha256') IS NOT json_extract(NEW.simulation,'$.allowanceSha256')
 THEN RAISE(ABORT,'Invalid complete group review scope') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM workspace_wallets WHERE owner_id=NEW.owner_id AND chain='Solana' AND address=NEW.payer AND role='Deployer')
 OR NOT EXISTS(SELECT 1 FROM launch_metadata_releases WHERE owner_id=NEW.owner_id AND project_id=NEW.project_id AND id=json_extract(NEW.terms,'$.releaseId'))
 THEN RAISE(ABORT,'Group deployer role or metadata release changed') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.review,'$.input.holders') h
 WHERE json_extract(h.value,'$.address') IS NOT json_extract(NEW.project_document,'$.options.wallets.recipients['||h.key||'].address')
 OR json_extract(h.value,'$.kind') IS NULL OR json_extract(h.value,'$.kind') NOT IN ('none','exact-base-output','exact-quote-input')
 OR json_extract(h.value,'$.address') IN (NEW.payer,NEW.mint))
 OR (SELECT count(DISTINCT json_extract(value,'$.address')) FROM json_each(NEW.review,'$.input.holders'))!=json_array_length(NEW.review,'$.input.holders')
 THEN RAISE(ABORT,'Group wallet slot scope differs') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.project_document,'$.options.wallets.recipients') ref WHERE NOT EXISTS(
 SELECT 1 FROM workspace_wallets w JOIN wallet_ownership_proofs o ON o.owner_id=w.owner_id AND o.chain=w.chain AND o.address=w.address
 WHERE w.owner_id=NEW.owner_id AND w.chain='Solana' AND w.role='Recipient' AND w.archived=0
 AND w.address=json_extract(ref.value,'$.address') AND w.revision=json_extract(ref.value,'$.revision') AND (
 json_extract(ref.value,'$.root')=1 OR
 (json_extract(ref.value,'$.folderRevision')=0 AND json_extract(ref.value,'$.folderId') IS NULL AND COALESCE(w.folder_ids, CASE WHEN w.folder_id='' THEN '[]' ELSE json_array(w.folder_id) END)='[]') OR
 EXISTS(SELECT 1 FROM wallet_folders f WHERE f.owner_id=w.owner_id AND f.chain='Solana' AND f.archived=0
 AND f.id=COALESCE(json_extract(ref.value,'$.folderId'),w.folder_id) AND f.revision=json_extract(ref.value,'$.folderRevision')
 AND EXISTS(SELECT 1 FROM json_each(COALESCE(w.folder_ids,json_array(w.folder_id))) WHERE value=f.id))
 ))) THEN RAISE(ABORT,'Holder wallet proof, role, revision or folder changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_group_launch_reservation BEFORE INSERT ON pump_launch_reviews BEGIN
 SELECT CASE WHEN (json_extract(NEW.review,'$.format')='pump-launch-group-review-v1' AND EXISTS(
 SELECT 1 FROM solana_execution_reservations WHERE owner_id=NEW.owner_id AND (wallet_address=NEW.payer OR wallet_address IN (
 SELECT json_extract(value,'$.address') FROM json_each(NEW.review,'$.input.holders') WHERE json_extract(value,'$.kind')!='none'))))
 OR EXISTS(SELECT 1 FROM pump_launch_reviews r WHERE r.owner_id=NEW.owner_id AND r.state NOT IN ('cancelled','failed','finalized')
 AND (json_extract(NEW.review,'$.format')='pump-launch-group-review-v1' OR json_extract(r.review,'$.format')='pump-launch-group-review-v1')
 AND (r.payer=NEW.payer OR r.payer IN (SELECT json_extract(value,'$.address') FROM json_each(NEW.review,'$.input.holders')
 WHERE json_extract(NEW.review,'$.format') IN ('pump-create-holders-review-v1','pump-launch-group-review-v1') AND json_extract(value,'$.kind')!='none')
 OR EXISTS(SELECT 1 FROM json_each(r.review,'$.input.holders') h
 WHERE json_extract(r.review,'$.format') IN ('pump-create-holders-review-v1','pump-launch-group-review-v1') AND json_extract(h.value,'$.kind')!='none'
 AND (json_extract(h.value,'$.address')=NEW.payer OR json_extract(h.value,'$.address') IN (
 SELECT json_extract(value,'$.address') FROM json_each(NEW.review,'$.input.holders')
 WHERE json_extract(NEW.review,'$.format') IN ('pump-create-holders-review-v1','pump-launch-group-review-v1') AND json_extract(value,'$.kind')!='none')))))
 THEN RAISE(ABORT,'Complete group wallet already reserved') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_group_shared_reservation BEFORE INSERT ON solana_execution_reservations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pump_launch_reviews r WHERE r.owner_id=NEW.owner_id AND r.state NOT IN ('cancelled','failed','finalized')
 AND json_extract(r.review,'$.format')='pump-launch-group-review-v1' AND (r.payer=NEW.wallet_address OR NEW.wallet_address IN (
 SELECT json_extract(value,'$.address') FROM json_each(r.review,'$.input.holders') WHERE json_extract(value,'$.kind')!='none')))
 THEN RAISE(ABORT,'Wallet reserved for complete group') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_group_stage_guard BEFORE UPDATE ON pump_launch_reviews
WHEN json_extract(OLD.review,'$.format')='pump-launch-group-review-v1' BEGIN
 SELECT CASE WHEN OLD.state!='review' OR NEW.state!='cancelled' OR NEW.signed IS NOT NULL OR NEW.signature IS NOT NULL OR NEW.receipt IS NOT NULL
 THEN RAISE(ABORT,'Group approval and execution are not enabled') END;
END;
