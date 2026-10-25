CREATE TABLE funding_save_stops (
 owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 128),
 stop_id TEXT NOT NULL CHECK(length(stop_id) BETWEEN 1 AND 64 AND stop_id NOT GLOB '*[^a-zA-Z0-9-]*'),
 plan_id TEXT NOT NULL CHECK(length(plan_id) BETWEEN 1 AND 64 AND plan_id NOT GLOB '*[^a-zA-Z0-9-]*'),
 expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 1000000000),
 action TEXT NOT NULL CHECK(action IN ('save','archive','restore') AND (expected_revision>0 OR action='save')),
 document_hash TEXT NOT NULL CHECK(length(document_hash)=64 AND document_hash NOT GLOB '*[^0-9a-f]*'),
 owner_scope TEXT NOT NULL CHECK(length(owner_scope)=64 AND owner_scope NOT GLOB '*[^0-9a-f]*'),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
 request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(CAST(request_json AS BLOB))<=2048),
 outcome TEXT NOT NULL CHECK(outcome IN ('creation_fenced','revision_advanced','already_advanced')),
 before_revision INTEGER,
 after_revision INTEGER,
 source_document TEXT,
 source_archived INTEGER,
 created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,stop_id),
 UNIQUE(owner_id,plan_id,expected_revision),
 CHECK((outcome='creation_fenced' AND expected_revision=0 AND action='save' AND before_revision IS NULL AND after_revision IS NULL AND source_document IS NULL AND source_archived IS NULL)
  OR (outcome='revision_advanced' AND typeof(before_revision)='integer' AND before_revision=expected_revision AND before_revision BETWEEN 1 AND 1000000000 AND typeof(after_revision)='integer' AND after_revision=before_revision+1 AND typeof(source_document)='text' AND typeof(source_archived)='integer' AND source_archived IN (0,1))
  OR (outcome='already_advanced' AND typeof(before_revision)='integer' AND before_revision>expected_revision AND before_revision BETWEEN 1 AND 1000000001 AND typeof(after_revision)='integer' AND after_revision=before_revision AND typeof(source_document)='text' AND typeof(source_archived)='integer' AND source_archived IN (0,1)))
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TRIGGER funding_save_stops_admission BEFORE INSERT ON funding_save_stops BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM funding_save_stops WHERE owner_id=NEW.owner_id AND (stop_id=NEW.stop_id OR (plan_id=NEW.plan_id AND expected_revision=NEW.expected_revision)))
 THEN RAISE(ABORT,'Funding stop identity already used') END;
 SELECT CASE WHEN (SELECT count(*) FROM funding_save_stops WHERE owner_id=NEW.owner_id)>=1000
 THEN RAISE(ABORT,'Funding stop capacity reached') END;
 SELECT CASE WHEN length(NEW.created_at)!=24 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) IS NOT NEW.created_at
 OR json_type(NEW.request_json) IS NOT 'object' OR (SELECT count(*) FROM json_each(NEW.request_json))!=4
 OR (SELECT count(DISTINCT key) FROM json_each(NEW.request_json))!=4
 OR EXISTS(SELECT 1 FROM json_each(NEW.request_json) WHERE key NOT IN ('format','stopId','reminder','consent'))
 OR json_extract(NEW.request_json,'$.format') IS NOT 'funding-save-stop-request-v1'
 OR json_extract(NEW.request_json,'$.stopId') IS NOT NEW.stop_id
 OR json_extract(NEW.request_json,'$.consent') IS NOT 'stop-draft-save-v1'
 OR json_type(NEW.request_json,'$.reminder') IS NOT 'object' OR (SELECT count(*) FROM json_each(NEW.request_json,'$.reminder'))!=6
 OR (SELECT count(DISTINCT key) FROM json_each(NEW.request_json,'$.reminder'))!=6
 OR EXISTS(SELECT 1 FROM json_each(NEW.request_json,'$.reminder') WHERE key NOT IN ('format','ownerScope','id','action','expectedRevision','documentHash'))
 OR json_extract(NEW.request_json,'$.reminder.format') IS NOT 'funding-save-reminder-v1'
 OR json_extract(NEW.request_json,'$.reminder.ownerScope') IS NOT NEW.owner_scope
 OR json_extract(NEW.request_json,'$.reminder.id') IS NOT NEW.plan_id
 OR json_extract(NEW.request_json,'$.reminder.action') IS NOT NEW.action
 OR json_type(NEW.request_json,'$.reminder.expectedRevision') IS NOT 'integer'
 OR json_extract(NEW.request_json,'$.reminder.expectedRevision') IS NOT NEW.expected_revision
 OR json_extract(NEW.request_json,'$.reminder.documentHash') IS NOT NEW.document_hash
 THEN RAISE(ABORT,'Funding stop record invalid') END;
 SELECT CASE WHEN NOT (
  (NEW.outcome='creation_fenced' AND NOT EXISTS(SELECT 1 FROM funding_plans WHERE owner_id=NEW.owner_id AND id=NEW.plan_id))
  OR (NEW.outcome IN ('revision_advanced','already_advanced') AND EXISTS(SELECT 1 FROM funding_plans p
   WHERE p.owner_id=NEW.owner_id AND p.id=NEW.plan_id AND p.revision IS NEW.before_revision
    AND p.document IS NEW.source_document AND p.archived IS NEW.source_archived))
 ) THEN RAISE(ABORT,'Funding stop source changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER funding_save_stops_advance AFTER INSERT ON funding_save_stops WHEN NEW.outcome='revision_advanced' BEGIN
 UPDATE funding_plans SET revision=NEW.after_revision,mutation_id=NEW.stop_id,updated_at=NEW.created_at
 WHERE owner_id=NEW.owner_id AND id=NEW.plan_id AND revision=NEW.before_revision
  AND document IS NEW.source_document AND archived IS NEW.source_archived;
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'Funding stop advance failed') END;
END;
--> statement-breakpoint
CREATE TRIGGER funding_save_stops_no_update BEFORE UPDATE ON funding_save_stops BEGIN
 SELECT RAISE(ABORT,'Funding stops are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER funding_save_stops_no_delete BEFORE DELETE ON funding_save_stops BEGIN
 SELECT RAISE(ABORT,'Funding stops are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER funding_plans_stop_insert BEFORE INSERT ON funding_plans BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM funding_save_stops WHERE owner_id=NEW.owner_id AND plan_id=NEW.id)
 THEN RAISE(ABORT,'Funding draft creation is fenced') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM funding_plans p JOIN funding_save_stops s ON s.owner_id=p.owner_id AND s.plan_id=p.id WHERE p.rowid=NEW.rowid)
 THEN RAISE(ABORT,'Funding stopped row cannot be replaced') END;
END;
--> statement-breakpoint
CREATE TRIGGER funding_plans_stop_update BEFORE UPDATE ON funding_plans
WHEN EXISTS(SELECT 1 FROM funding_save_stops WHERE (owner_id=OLD.owner_id AND plan_id=OLD.id) OR (owner_id=NEW.owner_id AND plan_id=NEW.id))
 OR EXISTS(SELECT 1 FROM funding_plans p JOIN funding_save_stops s ON s.owner_id=p.owner_id AND s.plan_id=p.id WHERE p.rowid=NEW.rowid) BEGIN
 SELECT CASE WHEN NEW.rowid IS NOT OLD.rowid OR NEW.owner_id IS NOT OLD.owner_id OR NEW.id IS NOT OLD.id OR typeof(NEW.revision)!='integer'
 OR NEW.revision!=OLD.revision+1 OR NEW.revision>1000000001
 THEN RAISE(ABORT,'Funding stopped revision cannot be rewritten') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM funding_save_stops WHERE owner_id=OLD.owner_id AND plan_id=OLD.id AND expected_revision>=OLD.revision)
 AND NOT EXISTS(SELECT 1 FROM funding_save_stops s WHERE s.owner_id=OLD.owner_id AND s.plan_id=OLD.id
  AND s.outcome='revision_advanced' AND s.before_revision=OLD.revision AND s.after_revision=NEW.revision
  AND s.stop_id=NEW.mutation_id AND s.created_at=NEW.updated_at
  AND NEW.document IS OLD.document AND NEW.archived IS OLD.archived
  AND s.source_document IS OLD.document AND s.source_archived IS OLD.archived)
 THEN RAISE(ABORT,'Funding original draft save is fenced') END;
END;
--> statement-breakpoint
CREATE TRIGGER funding_plans_stop_delete BEFORE DELETE ON funding_plans
WHEN EXISTS(SELECT 1 FROM funding_save_stops WHERE owner_id=OLD.owner_id AND plan_id=OLD.id) BEGIN
 SELECT RAISE(ABORT,'Funding stopped revisions must remain recoverable');
END;
