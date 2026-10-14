CREATE TABLE `pump_launch_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`project_id` text NOT NULL,
	`payer` text NOT NULL,
	`mint` text NOT NULL,
	`project_document` text NOT NULL,
	`terms` text NOT NULL,
	`review` text NOT NULL,
	`simulation` text NOT NULL,
	`state` text NOT NULL,
	`signed` text,
	`signature` text,
	`receipt` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pump_launch_owner_project` ON `pump_launch_reviews` (`owner_id`,`project_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX pump_launch_active_project ON pump_launch_reviews(owner_id,project_id) WHERE state NOT IN ('cancelled','failed');
--> statement-breakpoint
CREATE UNIQUE INDEX pump_launch_active_payer ON pump_launch_reviews(owner_id,payer) WHERE state NOT IN ('cancelled','failed','finalized');
--> statement-breakpoint
CREATE UNIQUE INDEX pump_launch_active_mint ON pump_launch_reviews(mint) WHERE state NOT IN ('cancelled','failed');
--> statement-breakpoint
CREATE TRIGGER pump_launch_insert_guard BEFORE INSERT ON pump_launch_reviews BEGIN
 SELECT CASE WHEN NEW.state!='review' OR NEW.signed IS NOT NULL OR NEW.signature IS NOT NULL OR NEW.receipt IS NOT NULL THEN RAISE(ABORT,'Invalid initial launch state') END;
 SELECT CASE WHEN julianday(NEW.expires_at)<=julianday('now') THEN RAISE(ABORT,'Launch review expired') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM workspace_projects WHERE owner_id=NEW.owner_id AND id=NEW.project_id AND document=NEW.project_document AND archived=0 AND updated_at=json_extract(NEW.terms,'$.updatedAt')) THEN RAISE(ABORT,'Launch project changed') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM workspace_wallets w JOIN wallet_ownership_proofs o ON o.owner_id=w.owner_id AND o.chain=w.chain AND o.address=w.address WHERE w.owner_id=NEW.owner_id AND w.chain='Solana' AND w.address=NEW.payer AND w.revision=json_extract(NEW.terms,'$.payerRevision') AND w.archived=0 AND (
 json_extract(NEW.project_document,'$.options.wallets.deployer.root')=1 OR
 (json_extract(NEW.project_document,'$.options.wallets.deployer.folderRevision')=0 AND json_extract(NEW.project_document,'$.options.wallets.deployer.folderId') IS NULL AND COALESCE(w.folder_ids,CASE WHEN w.folder_id='' THEN '[]' ELSE json_array(w.folder_id) END)='[]') OR
 EXISTS(SELECT 1 FROM wallet_folders f WHERE f.owner_id=w.owner_id AND f.id=COALESCE(json_extract(NEW.project_document,'$.options.wallets.deployer.folderId'),w.folder_id) AND f.chain='Solana' AND f.archived=0 AND f.revision=json_extract(NEW.project_document,'$.options.wallets.deployer.folderRevision') AND EXISTS(SELECT 1 FROM json_each(COALESCE(w.folder_ids,json_array(w.folder_id))) WHERE value=f.id))
 )) THEN RAISE(ABORT,'Launch payer or folder changed') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM solana_execution_reservations WHERE owner_id=NEW.owner_id AND wallet_address=NEW.payer) THEN RAISE(ABORT,'Payer already reserved') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_launch_shared_reservation BEFORE INSERT ON solana_execution_reservations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pump_launch_reviews WHERE owner_id=NEW.owner_id AND payer=NEW.wallet_address AND state NOT IN ('cancelled','failed','finalized')) THEN RAISE(ABORT,'Payer reserved for launch') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_launch_update_guard BEFORE UPDATE ON pump_launch_reviews BEGIN
 SELECT CASE WHEN NEW.id!=OLD.id OR NEW.owner_id!=OLD.owner_id OR NEW.project_id!=OLD.project_id OR NEW.payer!=OLD.payer OR NEW.mint!=OLD.mint OR NEW.project_document!=OLD.project_document OR NEW.terms!=OLD.terms OR NEW.review!=OLD.review OR NEW.simulation!=OLD.simulation OR NEW.created_at!=OLD.created_at OR NEW.expires_at!=OLD.expires_at THEN RAISE(ABORT,'Immutable launch review') END;
 SELECT CASE WHEN NOT ((OLD.state='review' AND NEW.state IN ('approved','cancelled')) OR (OLD.state='approved' AND NEW.state IN ('signed','cancelled')) OR (OLD.state='signed' AND NEW.state IN ('submitting','finalized','failed','cancelled')) OR (OLD.state='submitting' AND NEW.state IN ('submitted','finalized','failed','cancelled')) OR (OLD.state='submitted' AND NEW.state IN ('finalized','failed','cancelled'))) THEN RAISE(ABORT,'Invalid launch transition') END;
 SELECT CASE WHEN OLD.signed IS NOT NULL AND (NEW.signed IS NOT OLD.signed OR NEW.signature IS NOT OLD.signature) THEN RAISE(ABORT,'Immutable launch signature') END;
 SELECT CASE WHEN NEW.state IN ('signed','submitting','submitted','finalized','failed') AND (NEW.signed IS NULL OR NEW.signature IS NULL) THEN RAISE(ABORT,'Launch signature required') END;
 SELECT CASE WHEN NEW.state IN ('approved','submitting') AND NOT EXISTS(SELECT 1 FROM workspace_wallets w JOIN wallet_ownership_proofs o ON o.owner_id=w.owner_id AND o.chain=w.chain AND o.address=w.address WHERE w.owner_id=NEW.owner_id AND w.chain='Solana' AND w.address=NEW.payer AND w.revision=json_extract(NEW.terms,'$.payerRevision') AND w.archived=0 AND (
 json_extract(NEW.project_document,'$.options.wallets.deployer.root')=1 OR
 (json_extract(NEW.project_document,'$.options.wallets.deployer.folderRevision')=0 AND json_extract(NEW.project_document,'$.options.wallets.deployer.folderId') IS NULL AND COALESCE(w.folder_ids,CASE WHEN w.folder_id='' THEN '[]' ELSE json_array(w.folder_id) END)='[]') OR
 EXISTS(SELECT 1 FROM wallet_folders f WHERE f.owner_id=w.owner_id AND f.id=COALESCE(json_extract(NEW.project_document,'$.options.wallets.deployer.folderId'),w.folder_id) AND f.chain='Solana' AND f.archived=0 AND f.revision=json_extract(NEW.project_document,'$.options.wallets.deployer.folderRevision') AND EXISTS(SELECT 1 FROM json_each(COALESCE(w.folder_ids,json_array(w.folder_id))) WHERE value=f.id))
 )) THEN RAISE(ABORT,'Launch payer or folder changed') END;
 SELECT CASE WHEN NEW.state IN ('approved','submitting') AND (julianday(NEW.expires_at)<=julianday('now') OR NOT EXISTS(SELECT 1 FROM workspace_projects WHERE owner_id=NEW.owner_id AND id=NEW.project_id AND document=NEW.project_document AND archived=0 AND updated_at=json_extract(NEW.terms,'$.updatedAt'))) THEN RAISE(ABORT,'Launch context changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_launch_no_delete BEFORE DELETE ON pump_launch_reviews BEGIN SELECT RAISE(ABORT,'Launch history retained'); END;
