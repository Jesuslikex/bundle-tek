ALTER TABLE project_artwork ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1));
--> statement-breakpoint
ALTER TABLE project_artwork ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 1000000000);
--> statement-breakpoint
ALTER TABLE project_artwork ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE project_artwork SET updated_at=created_at WHERE updated_at='';
