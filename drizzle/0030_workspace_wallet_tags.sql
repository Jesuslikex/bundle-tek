ALTER TABLE workspace_wallets ADD COLUMN tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags)='array' AND json_array_length(tags)<=10);
