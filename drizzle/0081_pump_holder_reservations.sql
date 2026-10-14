CREATE TRIGGER pump_holder_review_insert BEFORE INSERT ON pump_launch_reviews
WHEN json_extract(NEW.review,'$.format')='pump-create-holders-review-v1' BEGIN
 SELECT CASE WHEN json_type(NEW.review,'$.input.holders') IS NOT 'array' OR json_array_length(NEW.review,'$.input.holders') NOT BETWEEN 1 AND 200
 OR json_array_length(NEW.review,'$.input.holders') IS NOT json_array_length(NEW.project_document,'$.options.wallets.recipients')
 OR json_extract(NEW.review,'$.projectId') IS NOT NEW.project_id OR json_extract(NEW.review,'$.projectUpdatedAt') IS NOT json_extract(NEW.terms,'$.updatedAt')
 OR json_extract(NEW.review,'$.input.create.payer') IS NOT NEW.payer OR json_extract(NEW.review,'$.input.create.mint') IS NOT NEW.mint
 OR json_extract(NEW.review,'$.expiresAt') IS NOT NEW.expires_at
 THEN RAISE(ABORT,'Invalid holder review scope') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.review,'$.input.holders') h
 WHERE json_extract(h.value,'$.address') IS NOT json_extract(NEW.project_document,'$.options.wallets.recipients['||h.key||'].address')
 OR json_extract(h.value,'$.kind') IS NULL OR json_extract(h.value,'$.kind') NOT IN ('none','exact-base-output','exact-quote-input')
 OR json_extract(h.value,'$.address') IN (NEW.payer,NEW.mint))
 OR (SELECT count(DISTINCT json_extract(value,'$.address')) FROM json_each(NEW.review,'$.input.holders'))!=json_array_length(NEW.review,'$.input.holders')
 THEN RAISE(ABORT,'Holder review slots differ') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.project_document,'$.options.wallets.recipients') ref WHERE NOT EXISTS(
 SELECT 1 FROM workspace_wallets w JOIN wallet_ownership_proofs o ON o.owner_id=w.owner_id AND o.chain=w.chain AND o.address=w.address
 WHERE w.owner_id=NEW.owner_id AND w.chain='Solana' AND w.role='Recipient' AND w.archived=0
 AND w.address=json_extract(ref.value,'$.address') AND w.revision=json_extract(ref.value,'$.revision') AND (
 json_extract(ref.value,'$.root')=1 OR
 (json_extract(ref.value,'$.folderRevision')=0 AND json_extract(ref.value,'$.folderId') IS NULL AND COALESCE(w.folder_ids,CASE WHEN w.folder_id='' THEN '[]' ELSE json_array(w.folder_id) END)='[]') OR
 EXISTS(SELECT 1 FROM wallet_folders f WHERE f.owner_id=w.owner_id AND f.chain='Solana' AND f.archived=0
 AND f.id=COALESCE(json_extract(ref.value,'$.folderId'),w.folder_id) AND f.revision=json_extract(ref.value,'$.folderRevision')
 AND EXISTS(SELECT 1 FROM json_each(COALESCE(w.folder_ids,json_array(w.folder_id))) WHERE value=f.id))
 ))) THEN RAISE(ABORT,'Holder wallet proof, role, revision or folder changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_holder_launch_reservation BEFORE INSERT ON pump_launch_reviews BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM solana_execution_reservations WHERE owner_id=NEW.owner_id AND wallet_address IN (SELECT json_extract(value,'$.address') FROM json_each(NEW.review,'$.input.holders')
 WHERE json_extract(NEW.review,'$.format')='pump-create-holders-review-v1' AND json_extract(value,'$.kind')!='none'))
 OR EXISTS(SELECT 1 FROM pump_launch_reviews r WHERE r.owner_id=NEW.owner_id AND r.state NOT IN ('cancelled','failed','finalized') AND (
 r.payer=NEW.payer OR r.payer IN (SELECT json_extract(value,'$.address') FROM json_each(NEW.review,'$.input.holders')
 WHERE json_extract(NEW.review,'$.format')='pump-create-holders-review-v1' AND json_extract(value,'$.kind')!='none') OR EXISTS(
 SELECT 1 FROM json_each(r.review,'$.input.holders') h WHERE json_extract(r.review,'$.format')='pump-create-holders-review-v1'
 AND json_extract(h.value,'$.kind')!='none' AND (json_extract(h.value,'$.address')=NEW.payer OR json_extract(h.value,'$.address') IN (SELECT json_extract(value,'$.address') FROM json_each(NEW.review,'$.input.holders')
 WHERE json_extract(NEW.review,'$.format')='pump-create-holders-review-v1' AND json_extract(value,'$.kind')!='none'))
 ))) THEN RAISE(ABORT,'Launch wallet already reserved') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_holder_shared_reservation BEFORE INSERT ON solana_execution_reservations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pump_launch_reviews r,json_each(r.review,'$.input.holders') h
 WHERE r.owner_id=NEW.owner_id AND r.state NOT IN ('cancelled','failed','finalized')
 AND json_extract(r.review,'$.format')='pump-create-holders-review-v1' AND json_extract(h.value,'$.kind')!='none'
 AND json_extract(h.value,'$.address')=NEW.wallet_address) THEN RAISE(ABORT,'Wallet reserved for holder launch') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_holder_review_transition BEFORE UPDATE OF state ON pump_launch_reviews
WHEN json_extract(NEW.review,'$.format')='pump-create-holders-review-v1' AND NEW.state IN ('approved','submitting') BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.project_document,'$.options.wallets.recipients') ref WHERE NOT EXISTS(
 SELECT 1 FROM workspace_wallets w JOIN wallet_ownership_proofs o ON o.owner_id=w.owner_id AND o.chain=w.chain AND o.address=w.address
 WHERE w.owner_id=NEW.owner_id AND w.chain='Solana' AND w.role='Recipient' AND w.archived=0
 AND w.address=json_extract(ref.value,'$.address') AND w.revision=json_extract(ref.value,'$.revision') AND (
 json_extract(ref.value,'$.root')=1 OR
 (json_extract(ref.value,'$.folderRevision')=0 AND json_extract(ref.value,'$.folderId') IS NULL AND COALESCE(w.folder_ids,CASE WHEN w.folder_id='' THEN '[]' ELSE json_array(w.folder_id) END)='[]') OR
 EXISTS(SELECT 1 FROM wallet_folders f WHERE f.owner_id=w.owner_id AND f.chain='Solana' AND f.archived=0
 AND f.id=COALESCE(json_extract(ref.value,'$.folderId'),w.folder_id) AND f.revision=json_extract(ref.value,'$.folderRevision')
 AND EXISTS(SELECT 1 FROM json_each(COALESCE(w.folder_ids,json_array(w.folder_id))) WHERE value=f.id))
 ))) THEN RAISE(ABORT,'Holder wallet proof, role, revision or folder changed') END;
END;
