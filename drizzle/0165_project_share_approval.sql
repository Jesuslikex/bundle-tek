ALTER TABLE project_shares ADD COLUMN approval INTEGER NOT NULL DEFAULT 0 CHECK(approval IN (0,1));
--> statement-breakpoint
ALTER TABLE project_shares ADD COLUMN requester_id TEXT;
--> statement-breakpoint
ALTER TABLE project_shares ADD COLUMN requested_at TEXT;
--> statement-breakpoint
CREATE TRIGGER project_shares_approval_insert BEFORE INSERT ON project_shares BEGIN
 SELECT CASE WHEN typeof(NEW.approval)<>'integer' OR NEW.approval NOT IN (0,1)
  OR NEW.requester_id IS NOT NULL OR NEW.requested_at IS NOT NULL
 THEN RAISE(ABORT,'Share approval invalid') END;
END;
--> statement-breakpoint
CREATE TRIGGER project_shares_approval_update BEFORE UPDATE ON project_shares BEGIN
 SELECT CASE WHEN NEW.approval IS NOT OLD.approval THEN RAISE(ABORT,'Share approval is immutable') END;
 SELECT CASE WHEN OLD.requester_id IS NOT NULL
  AND (NEW.requester_id IS NOT OLD.requester_id OR NEW.requested_at IS NOT OLD.requested_at)
 THEN RAISE(ABORT,'Share request is immutable') END;
 SELECT CASE WHEN OLD.requester_id IS NULL AND (NEW.requester_id IS NOT NULL OR NEW.requested_at IS NOT NULL)
  AND (OLD.approval<>1 OR OLD.member_id IS NOT NULL OR NEW.member_id IS NOT NULL
   OR NEW.requester_id IS NULL OR typeof(NEW.requester_id)<>'text' OR NEW.requester_id=OLD.owner_id
   OR NEW.requested_at IS NULL OR typeof(NEW.requested_at)<>'text'
   OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.requested_at) IS NOT NEW.requested_at
   OR (OLD.expires_at IS NOT NULL AND OLD.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')))
 THEN RAISE(ABORT,'Share request invalid') END;
 SELECT CASE WHEN OLD.approval=1 AND OLD.member_id IS NULL AND NEW.member_id IS NOT NULL
  AND (OLD.requester_id IS NULL OR NEW.member_id IS NOT OLD.requester_id)
 THEN RAISE(ABORT,'Share needs owner approval') END;
END;
