ALTER TABLE project_shares ADD COLUMN expires_at TEXT;
--> statement-breakpoint
CREATE TRIGGER project_shares_expiry_insert BEFORE INSERT ON project_shares BEGIN
 SELECT CASE WHEN NEW.expires_at IS NULL
  OR typeof(NEW.expires_at)<>'text'
  OR length(NEW.expires_at)<>24
  OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) IS NOT NEW.created_at
  OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.expires_at) IS NOT NEW.expires_at
  OR NEW.expires_at NOT IN (
   strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at,'+1 hour'),
   strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at,'+1 day'),
   strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at,'+7 days'))
  OR NEW.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 THEN RAISE(ABORT,'Share expiry invalid') END;
END;
--> statement-breakpoint
CREATE TRIGGER project_shares_expiry_immutable BEFORE UPDATE ON project_shares BEGIN
 SELECT CASE WHEN NEW.expires_at IS NOT OLD.expires_at THEN RAISE(ABORT,'Share expiry is immutable') END;
 SELECT CASE WHEN OLD.member_id IS NULL AND NEW.member_id IS NOT NULL
  AND OLD.expires_at IS NOT NULL AND OLD.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 THEN RAISE(ABORT,'Share expired') END;
END;
