CREATE TABLE trade_amount_preferences (
 owner_id TEXT PRIMARY KEY NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 128),
 revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 1000000000),
 document TEXT NOT NULL CHECK(json_valid(document) AND length(document)<=4096),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER trade_amount_preferences_insert BEFORE INSERT ON trade_amount_preferences BEGIN
 SELECT CASE WHEN NEW.revision<>1 THEN RAISE(ABORT,'Initial preset revision required') END;
 SELECT CASE WHEN json_type(NEW.document)<>'object' OR json_extract(NEW.document,'$.format') IS NOT 'trade-amount-presets-v1'
 OR (SELECT count(*) FROM json_each(NEW.document))<>4
 OR EXISTS(SELECT 1 FROM json_each(NEW.document) WHERE key NOT IN ('format','buySol','sellBalanceBps','sellSupplyBps'))
 OR json_type(NEW.document,'$.buySol') IS NOT 'array' OR json_array_length(NEW.document,'$.buySol') NOT BETWEEN 1 AND 8
 OR json_type(NEW.document,'$.sellBalanceBps') IS NOT 'array' OR json_array_length(NEW.document,'$.sellBalanceBps') NOT BETWEEN 1 AND 8
 OR json_type(NEW.document,'$.sellSupplyBps') IS NOT 'array' OR json_array_length(NEW.document,'$.sellSupplyBps') NOT BETWEEN 1 AND 8
 OR EXISTS(SELECT 1 FROM json_each(NEW.document,'$.buySol') WHERE type<>'text' OR length(value) NOT BETWEEN 1 AND 40)
 OR EXISTS(SELECT 1 FROM json_each(NEW.document,'$.sellBalanceBps') WHERE type<>'integer' OR value NOT BETWEEN 1 AND 10000)
 OR EXISTS(SELECT 1 FROM json_each(NEW.document,'$.sellSupplyBps') WHERE type<>'integer' OR value NOT BETWEEN 1 AND 10000)
 OR NEW.created_at<>NEW.updated_at OR NEW.updated_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ',NEW.updated_at)
 THEN RAISE(ABORT,'Invalid presentation preset document') END;
END;
--> statement-breakpoint
CREATE TRIGGER trade_amount_preferences_update BEFORE UPDATE ON trade_amount_preferences BEGIN
 SELECT CASE WHEN NEW.owner_id IS NOT OLD.owner_id OR NEW.created_at IS NOT OLD.created_at OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
 OR NEW.updated_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ',NEW.updated_at)
 OR json_type(NEW.document)<>'object' OR json_extract(NEW.document,'$.format') IS NOT 'trade-amount-presets-v1'
 OR (SELECT count(*) FROM json_each(NEW.document))<>4
 OR EXISTS(SELECT 1 FROM json_each(NEW.document) WHERE key NOT IN ('format','buySol','sellBalanceBps','sellSupplyBps'))
 OR json_type(NEW.document,'$.buySol') IS NOT 'array' OR json_array_length(NEW.document,'$.buySol') NOT BETWEEN 1 AND 8
 OR json_type(NEW.document,'$.sellBalanceBps') IS NOT 'array' OR json_array_length(NEW.document,'$.sellBalanceBps') NOT BETWEEN 1 AND 8
 OR json_type(NEW.document,'$.sellSupplyBps') IS NOT 'array' OR json_array_length(NEW.document,'$.sellSupplyBps') NOT BETWEEN 1 AND 8
 OR EXISTS(SELECT 1 FROM json_each(NEW.document,'$.buySol') WHERE type<>'text' OR length(value) NOT BETWEEN 1 AND 40)
 OR EXISTS(SELECT 1 FROM json_each(NEW.document,'$.sellBalanceBps') WHERE type<>'integer' OR value NOT BETWEEN 1 AND 10000)
 OR EXISTS(SELECT 1 FROM json_each(NEW.document,'$.sellSupplyBps') WHERE type<>'integer' OR value NOT BETWEEN 1 AND 10000)
 THEN RAISE(ABORT,'Invalid preset revision or presentation document') END;
END;
--> statement-breakpoint
CREATE TRIGGER trade_amount_preferences_retained BEFORE DELETE ON trade_amount_preferences BEGIN SELECT RAISE(ABORT,'Reset presets through a new revision'); END;
