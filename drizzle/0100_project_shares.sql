CREATE TABLE project_shares(
 id TEXT PRIMARY KEY NOT NULL,owner_id TEXT NOT NULL,project_id TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,member_id TEXT,
 created_at TEXT NOT NULL,accepted_at TEXT,revoked_at TEXT,
 CHECK(member_id IS NULL OR member_id<>owner_id),
 CHECK((member_id IS NULL)=(accepted_at IS NULL))
);
--> statement-breakpoint
CREATE INDEX project_shares_project ON project_shares(owner_id,project_id,created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX project_shares_member ON project_shares(owner_id,project_id,member_id) WHERE member_id IS NOT NULL AND revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX project_shares_member_lookup ON project_shares(member_id) WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER project_shares_insert BEFORE INSERT ON project_shares BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM workspace_projects WHERE owner_id=NEW.owner_id AND id=NEW.project_id) THEN RAISE(ABORT,'Project not found') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM project_shares WHERE owner_id=NEW.owner_id AND project_id=NEW.project_id AND revoked_at IS NULL)>=10 THEN RAISE(ABORT,'Share limit reached') END;
END;
--> statement-breakpoint
CREATE TRIGGER project_shares_immutable BEFORE UPDATE ON project_shares BEGIN
 SELECT CASE WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.project_id<>OLD.project_id OR NEW.token_hash<>OLD.token_hash OR NEW.created_at<>OLD.created_at THEN RAISE(ABORT,'Share identity is immutable') END;
 SELECT CASE WHEN OLD.revoked_at IS NOT NULL THEN RAISE(ABORT,'Share revoked') END;
 SELECT CASE WHEN OLD.member_id IS NOT NULL AND (NEW.member_id IS NOT OLD.member_id OR NEW.accepted_at IS NOT OLD.accepted_at) THEN RAISE(ABORT,'Share already accepted') END;
END;
