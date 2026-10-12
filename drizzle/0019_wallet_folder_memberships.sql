ALTER TABLE workspace_wallets ADD COLUMN folder_ids TEXT;
--> statement-breakpoint
UPDATE workspace_wallets SET folder_ids=json_array(folder_id);
