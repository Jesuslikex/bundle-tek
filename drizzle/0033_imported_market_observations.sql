CREATE TABLE imported_market_observations (
 owner_id TEXT NOT NULL, project_id TEXT NOT NULL, document TEXT NOT NULL,
 observed_at TEXT NOT NULL, PRIMARY KEY(owner_id,project_id)
);
--> statement-breakpoint
CREATE TABLE market_read_gates (owner_id TEXT PRIMARY KEY NOT NULL,next_allowed_at INTEGER NOT NULL);
