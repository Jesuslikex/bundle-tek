CREATE TABLE imported_supply_scopes(owner_id TEXT NOT NULL,project_id TEXT NOT NULL,id TEXT NOT NULL,document TEXT NOT NULL CHECK(json_valid(document)),created_at TEXT NOT NULL,PRIMARY KEY(owner_id,project_id,id));
--> statement-breakpoint
CREATE TABLE imported_supply_observations(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,owner_id TEXT NOT NULL,project_id TEXT NOT NULL,scope_id TEXT NOT NULL,document TEXT NOT NULL CHECK(json_valid(document)),created_at TEXT NOT NULL,FOREIGN KEY(owner_id,project_id,scope_id) REFERENCES imported_supply_scopes(owner_id,project_id,id));
--> statement-breakpoint
CREATE INDEX imported_supply_observations_scope ON imported_supply_observations(owner_id,project_id,scope_id,sequence DESC);
--> statement-breakpoint
CREATE TABLE imported_supply_read_gates(owner_id TEXT PRIMARY KEY NOT NULL,next_allowed_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE TRIGGER imported_supply_observations_immutable_update BEFORE UPDATE ON imported_supply_observations BEGIN SELECT RAISE(ABORT,'Supply history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER imported_supply_observations_immutable_delete BEFORE DELETE ON imported_supply_observations BEGIN SELECT RAISE(ABORT,'Supply history is retained'); END;
--> statement-breakpoint
CREATE TRIGGER imported_supply_scopes_immutable_update BEFORE UPDATE ON imported_supply_scopes BEGIN SELECT RAISE(ABORT,'Supply scope is immutable'); END;
