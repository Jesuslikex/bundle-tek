CREATE TABLE auto_sell_run_record_stops (
 owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 128),run_id TEXT NOT NULL,
 project_id TEXT NOT NULL,profile_save_id TEXT NOT NULL,
 profile_sha256 TEXT NOT NULL CHECK(length(profile_sha256)=64 AND profile_sha256 NOT GLOB '*[^a-f0-9]*'),
 request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^a-f0-9]*'),
 status TEXT NOT NULL CHECK(status IN ('creation-fenced','record-found')),
 run_sha256 TEXT,created_at TEXT NOT NULL,
 CHECK((status='creation-fenced' AND run_sha256 IS NULL) OR (status='record-found' AND typeof(run_sha256)='text' AND length(run_sha256)=64 AND run_sha256 NOT GLOB '*[^a-f0-9]*')),
 PRIMARY KEY(owner_id,run_id)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_record_stops_insert BEFORE INSERT ON auto_sell_run_record_stops BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM auto_sell_run_record_stops WHERE owner_id=NEW.owner_id AND run_id=NEW.run_id) THEN RAISE(ABORT,'Original record stop already retained') END;
 SELECT CASE WHEN (SELECT count(*) FROM auto_sell_run_record_stops WHERE owner_id=NEW.owner_id)>=1000 THEN RAISE(ABORT,'Original record stop history full') END;
 SELECT CASE WHEN strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) IS NOT NEW.created_at OR abs(julianday(NEW.created_at)-julianday('now'))>0.000058 THEN RAISE(ABORT,'Original record stop clock invalid') END;
 SELECT CASE WHEN NOT (
 (NEW.status='creation-fenced' AND NOT EXISTS(SELECT 1 FROM auto_sell_runs WHERE owner_id=NEW.owner_id AND id=NEW.run_id)) OR
 (NEW.status='record-found' AND EXISTS(SELECT 1 FROM auto_sell_runs WHERE owner_id=NEW.owner_id AND id=NEW.run_id AND project_id=NEW.project_id AND profile_save_id=NEW.profile_save_id AND profile_sha256=NEW.profile_sha256 AND sha256=NEW.run_sha256))
 ) THEN RAISE(ABORT,'Original record identity changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_record_stops_no_update BEFORE UPDATE ON auto_sell_run_record_stops BEGIN SELECT RAISE(ABORT,'Original record stops are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_record_stops_no_delete BEFORE DELETE ON auto_sell_run_record_stops BEGIN SELECT RAISE(ABORT,'Original record stops are retained'); END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_runs_record_stop_fence BEFORE INSERT ON auto_sell_runs BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM auto_sell_run_record_stops WHERE owner_id=NEW.owner_id AND run_id=NEW.id) THEN RAISE(ABORT,'Auto Sell original run record request changed: permanently fenced') END;
END;
