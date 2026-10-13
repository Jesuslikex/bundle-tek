CREATE TABLE `counter_trade_plans` (
	`owner_id` text NOT NULL,
	`project_id` text NOT NULL,
	`id` text NOT NULL,
	`revision` integer NOT NULL,
	`state` text NOT NULL,
	`document` text NOT NULL,
	PRIMARY KEY(`owner_id`, `project_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `counter_trade_plans_scope` ON `counter_trade_plans` (`owner_id`,`project_id`);
--> statement-breakpoint
CREATE TRIGGER counter_trade_plan_insert_guard
BEFORE INSERT ON counter_trade_plans
BEGIN
  SELECT RAISE(ABORT, 'invalid counter plan') WHERE
    json_valid(NEW.document) IS NOT 1
    OR NEW.revision IS NOT 1 OR NEW.state IS NOT 'active'
    OR json_extract(NEW.document,'$.format') IS NOT 'counter-plan-v1'
    OR json_extract(NEW.document,'$.executionAllowed') IS NOT 0
    OR json_extract(NEW.document,'$.id') IS NOT NEW.id
    OR json_extract(NEW.document,'$.projectId') IS NOT NEW.project_id
    OR json_extract(NEW.document,'$.revision') IS NOT NEW.revision
    OR json_extract(NEW.document,'$.state') IS NOT NEW.state
    OR json_extract(NEW.document,'$.ledger.scope.projectId') IS NOT NEW.project_id
    OR json_extract(NEW.document,'$.ledger.queuedTokenRaw') IS NOT '0'
    OR json_type(NEW.document,'$.ledger.decisions') IS NOT 'array'
    OR json_array_length(NEW.document,'$.ledger.decisions') IS NOT 0;
END;
--> statement-breakpoint
CREATE TRIGGER counter_trade_plan_update_guard
BEFORE UPDATE ON counter_trade_plans
BEGIN
  SELECT RAISE(ABORT, 'invalid counter transition') WHERE
    NEW.owner_id IS NOT OLD.owner_id OR NEW.project_id IS NOT OLD.project_id OR NEW.id IS NOT OLD.id
    OR NEW.revision IS NOT OLD.revision+1 OR OLD.state='ended'
    OR NEW.state NOT IN ('active','paused','ended') OR json_valid(NEW.document) IS NOT 1
    OR json_extract(NEW.document,'$.format') IS NOT 'counter-plan-v1'
    OR json_extract(NEW.document,'$.executionAllowed') IS NOT 0
    OR json_extract(NEW.document,'$.id') IS NOT NEW.id
    OR json_extract(NEW.document,'$.projectId') IS NOT NEW.project_id
    OR json_extract(NEW.document,'$.revision') IS NOT NEW.revision
    OR json_extract(NEW.document,'$.state') IS NOT NEW.state
    OR json_extract(NEW.document,'$.createdAt') IS NOT json_extract(OLD.document,'$.createdAt')
    OR json_extract(NEW.document,'$.projectDocument') IS NOT json_extract(OLD.document,'$.projectDocument')
    OR json_extract(NEW.document,'$.rules') IS NOT json_extract(OLD.document,'$.rules')
    OR json_extract(NEW.document,'$.ledger.rulesKey') IS NOT json_extract(OLD.document,'$.ledger.rulesKey')
    OR json_extract(NEW.document,'$.ledger.scope') IS NOT json_extract(OLD.document,'$.ledger.scope')
    OR json_type(NEW.document,'$.ledger.decisions') IS NOT 'array'
    OR json_array_length(NEW.document,'$.ledger.decisions') NOT BETWEEN json_array_length(OLD.document,'$.ledger.decisions') AND json_array_length(OLD.document,'$.ledger.decisions')+1
    OR json_array_length(NEW.document,'$.ledger.decisions')>1000
    OR (json_array_length(NEW.document,'$.ledger.decisions')=json_array_length(OLD.document,'$.ledger.decisions') AND json_extract(NEW.document,'$.ledger.queuedTokenRaw') IS NOT json_extract(OLD.document,'$.ledger.queuedTokenRaw'))
    OR ((OLD.state<>'active' OR NEW.state<>'active') AND json_array_length(NEW.document,'$.ledger.decisions')<>json_array_length(OLD.document,'$.ledger.decisions'))
    OR EXISTS(SELECT 1 FROM json_each(OLD.document,'$.ledger.decisions') prior LEFT JOIN json_each(NEW.document,'$.ledger.decisions') incoming ON incoming.key=prior.key WHERE incoming.key IS NULL OR incoming.value IS NOT prior.value);
END;
