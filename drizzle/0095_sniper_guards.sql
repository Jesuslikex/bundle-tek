CREATE TABLE sniper_guards(id TEXT PRIMARY KEY NOT NULL,owner_id TEXT NOT NULL,project_id TEXT NOT NULL,review_id TEXT NOT NULL REFERENCES pump_launch_reviews(id),revision INTEGER NOT NULL,state TEXT NOT NULL,settings TEXT NOT NULL,launch TEXT,observation TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,armed_at TEXT,finished_at TEXT);
--> statement-breakpoint
CREATE UNIQUE INDEX sniper_guards_owner_review ON sniper_guards(owner_id,review_id);
--> statement-breakpoint
CREATE INDEX sniper_guards_owner_project ON sniper_guards(owner_id,project_id);
--> statement-breakpoint
CREATE TRIGGER sniper_guard_insert_guard BEFORE INSERT ON sniper_guards BEGIN
 SELECT RAISE(ABORT,'invalid sniper guard') WHERE NEW.revision IS NOT 1 OR NEW.state IS NOT 'planned' OR json_valid(NEW.settings) IS NOT 1 OR json_extract(NEW.settings,'$.format') IS NOT 'sniper-guard-settings-v1' OR NEW.launch IS NOT NULL OR NEW.observation IS NOT NULL OR NEW.armed_at IS NOT NULL OR NEW.finished_at IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER sniper_guard_update_guard BEFORE UPDATE ON sniper_guards BEGIN
 SELECT RAISE(ABORT,'sniper guard transition rejected') WHERE NEW.id IS NOT OLD.id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.project_id IS NOT OLD.project_id OR NEW.review_id IS NOT OLD.review_id OR NEW.created_at IS NOT OLD.created_at OR NEW.revision IS NOT OLD.revision+1
  OR OLD.state IN ('triggered','ended','stopped')
  OR NOT ((OLD.state='planned' AND NEW.state IN ('planned','watching','stopped')) OR (OLD.state='watching' AND NEW.state IN ('watching','triggered','ended','stopped')))
  OR json_valid(NEW.settings) IS NOT 1 OR json_extract(NEW.settings,'$.format') IS NOT 'sniper-guard-settings-v1'
  OR (OLD.state<>'planned' AND NEW.settings IS NOT OLD.settings)
  OR (OLD.launch IS NOT NULL AND NEW.launch IS NOT OLD.launch)
  OR (OLD.armed_at IS NOT NULL AND NEW.armed_at IS NOT OLD.armed_at)
  OR (NEW.state='watching' AND (NEW.launch IS NULL OR NEW.armed_at IS NULL OR NEW.observation IS NULL OR json_valid(NEW.observation) IS NOT 1))
  OR (NEW.state='triggered' AND (OLD.state IS NOT 'watching' OR json_extract(NEW.observation,'$.evaluation.triggered') IS NOT 1))
  OR (NEW.state IN ('planned','watching') AND NEW.finished_at IS NOT NULL)
  OR (NEW.state IN ('triggered','ended','stopped') AND NEW.finished_at IS NULL);
END;
--> statement-breakpoint
CREATE TRIGGER sniper_guard_no_delete BEFORE DELETE ON sniper_guards BEGIN SELECT RAISE(ABORT,'Sniper guard history retained'); END;
