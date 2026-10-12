CREATE TABLE supply_movement_evidence(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,owner_id TEXT NOT NULL,project_id TEXT NOT NULL,observation_id TEXT NOT NULL,wallet_address TEXT NOT NULL,document TEXT NOT NULL CHECK(json_valid(document)),created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE INDEX supply_movement_evidence_scope ON supply_movement_evidence(owner_id,project_id,observation_id,wallet_address,sequence DESC);
--> statement-breakpoint
CREATE TRIGGER supply_movement_evidence_keep_update BEFORE UPDATE ON supply_movement_evidence BEGIN SELECT RAISE(ABORT,'Movement evidence is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER supply_movement_evidence_keep_delete BEFORE DELETE ON supply_movement_evidence BEGIN SELECT RAISE(ABORT,'Movement evidence is retained'); END;
