CREATE TABLE imported_token_projects (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  document TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  mutation_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id,id),
  UNIQUE (owner_id,chain,address)
);
--> statement-breakpoint
CREATE TABLE imported_token_project_events (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,
  revision INTEGER NOT NULL,
  document TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(owner_id,project_id,revision)
);
--> statement-breakpoint
CREATE TABLE imported_token_project_gates (
  owner_id TEXT PRIMARY KEY NOT NULL,
  next_allowed_at INTEGER NOT NULL
);
