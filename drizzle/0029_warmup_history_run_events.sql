ALTER TABLE warmup_history_runs ADD COLUMN last_event TEXT NOT NULL DEFAULT 'run.snapshot';
--> statement-breakpoint
CREATE TABLE warmup_history_run_events (
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL,
  type TEXT NOT NULL,
  state TEXT NOT NULL,
  completed_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  wallet_address TEXT,
  result_document TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,run_id,revision)
);
--> statement-breakpoint
CREATE INDEX idx_warmup_run_event_plan ON warmup_history_run_events(owner_id,plan_id,created_at,run_id,revision);
--> statement-breakpoint
INSERT INTO warmup_history_run_events(owner_id,run_id,revision,plan_id,plan_revision,type,state,completed_count,error_count,created_at)
SELECT owner_id,id,revision,plan_id,plan_revision,'run.snapshot',state,json_array_length(document,'$.results'),
 (SELECT COUNT(*) FROM json_each(document,'$.results') WHERE json_extract(value,'$.error') IS NOT NULL),updated_at
FROM warmup_history_runs;
--> statement-breakpoint
CREATE TRIGGER warmup_run_event_insert AFTER INSERT ON warmup_history_runs
BEGIN
 INSERT INTO warmup_history_run_events(owner_id,run_id,revision,plan_id,plan_revision,type,state,completed_count,error_count,created_at)
 VALUES(NEW.owner_id,NEW.id,NEW.revision,NEW.plan_id,NEW.plan_revision,NEW.last_event,NEW.state,json_array_length(NEW.document,'$.results'),
 (SELECT COUNT(*) FROM json_each(NEW.document,'$.results') WHERE json_extract(value,'$.error') IS NOT NULL),NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_run_event_update AFTER UPDATE ON warmup_history_runs
WHEN NEW.revision<>OLD.revision
BEGIN
 INSERT INTO warmup_history_run_events(owner_id,run_id,revision,plan_id,plan_revision,type,state,completed_count,error_count,wallet_address,result_document,created_at)
 VALUES(NEW.owner_id,NEW.id,NEW.revision,NEW.plan_id,NEW.plan_revision,NEW.last_event,NEW.state,json_array_length(NEW.document,'$.results'),
 (SELECT COUNT(*) FROM json_each(NEW.document,'$.results') WHERE json_extract(value,'$.error') IS NOT NULL),
 CASE WHEN NEW.last_event IN ('run.read_started','run.read_recovered') THEN json_extract(NEW.document,'$.wallets['||json_array_length(NEW.document,'$.results')||'].address')
 WHEN json_array_length(NEW.document,'$.results')>json_array_length(OLD.document,'$.results') THEN json_extract(NEW.document,'$.results[#-1].address') ELSE NULL END,
 CASE WHEN json_array_length(NEW.document,'$.results')>json_array_length(OLD.document,'$.results') THEN json_extract(NEW.document,'$.results[#-1]') ELSE NULL END,
 NEW.updated_at);
END;
