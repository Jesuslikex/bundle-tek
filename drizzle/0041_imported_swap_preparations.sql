CREATE TABLE imported_swap_preparations (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_revision INTEGER NOT NULL,
  wallet_address TEXT NOT NULL,
  wallet_revision INTEGER NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document) AND length(document)<=8192),
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX imported_swap_preparations_project ON imported_swap_preparations(owner_id,project_id,created_at,id);
