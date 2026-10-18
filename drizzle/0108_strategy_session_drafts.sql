CREATE TABLE strategy_session_drafts (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 project_revision INTEGER NOT NULL CHECK(project_revision>0),
 revision INTEGER NOT NULL CHECK(revision>0),
 archived INTEGER NOT NULL CHECK(archived IN (0,1)),
 document TEXT NOT NULL CHECK(length(document)<=40000 AND json_valid(document)
  AND json_extract(document,'$.format') IS 'strategy-session-draft-v1'
  AND json_type(document,'$.planningOnly') IS 'true'
  AND json_type(document,'$.fundingAllowed') IS 'false'
  AND json_type(document,'$.signingAllowed') IS 'false'
  AND json_type(document,'$.executionAllowed') IS 'false'),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX strategy_session_drafts_owner ON strategy_session_drafts(owner_id,project_id,archived,created_at,id);
--> statement-breakpoint
CREATE TRIGGER strategy_session_drafts_immutable BEFORE UPDATE ON strategy_session_drafts BEGIN
 SELECT CASE WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.project_id<>OLD.project_id OR NEW.project_revision<>OLD.project_revision
 OR NEW.document<>OLD.document OR NEW.sha256<>OLD.sha256 OR NEW.created_at<>OLD.created_at
 OR NEW.revision<>OLD.revision+1 OR NEW.archived=OLD.archived
 THEN RAISE(ABORT,'Strategy terms are immutable; save a new draft') END;
END;
--> statement-breakpoint
CREATE TRIGGER strategy_session_drafts_retained BEFORE DELETE ON strategy_session_drafts BEGIN
 SELECT RAISE(ABORT,'Archive strategy drafts instead');
END;
