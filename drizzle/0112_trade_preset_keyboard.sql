DROP TRIGGER trade_amount_preferences_insert;
--> statement-breakpoint
DROP TRIGGER trade_amount_preferences_update;
--> statement-breakpoint
CREATE TRIGGER trade_amount_preferences_insert BEFORE INSERT ON trade_amount_preferences BEGIN
 SELECT CASE WHEN NEW.revision<>1 THEN RAISE(ABORT,'Initial preset revision required') END;
 SELECT CASE WHEN json_type(NEW.document)<>'object' OR (json_extract(NEW.document,'$.format') IS NOT 'trade-amount-presets-v1' AND json_extract(NEW.document,'$.format') IS NOT 'trade-amount-presets-v2')
 OR (SELECT count(*) FROM json_each(NEW.document))<> (4 + (json_extract(NEW.document,'$.format')='trade-amount-presets-v2'))
 OR EXISTS(SELECT 1 FROM json_each(NEW.document) WHERE key NOT IN ('format','buySol','sellBalanceBps','sellSupplyBps','keyboard'))
 OR json_type(NEW.document,'$.buySol') IS NOT 'array' OR json_array_length(NEW.document,'$.buySol') NOT BETWEEN 1 AND 8
 OR json_type(NEW.document,'$.sellBalanceBps') IS NOT 'array' OR json_array_length(NEW.document,'$.sellBalanceBps') NOT BETWEEN 1 AND 8
 OR json_type(NEW.document,'$.sellSupplyBps') IS NOT 'array' OR json_array_length(NEW.document,'$.sellSupplyBps') NOT BETWEEN 1 AND 8
 OR EXISTS(SELECT 1 FROM json_each(NEW.document,'$.buySol') WHERE type<>'text' OR length(value) NOT BETWEEN 1 AND 40)
 OR EXISTS(SELECT 1 FROM json_each(NEW.document,'$.sellBalanceBps') WHERE type<>'integer' OR value NOT BETWEEN 1 AND 10000)
 OR EXISTS(SELECT 1 FROM json_each(NEW.document,'$.sellSupplyBps') WHERE type<>'integer' OR value NOT BETWEEN 1 AND 10000)
 OR NEW.created_at<>NEW.updated_at OR NEW.updated_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ',NEW.updated_at)
 OR (json_extract(NEW.document,'$.format')='trade-amount-presets-v2' AND (
 json_type(NEW.document,'$.keyboard') IS NOT 'object'
 OR (SELECT count(*) FROM json_each(NEW.document,'$.keyboard'))<>3
 OR EXISTS(SELECT 1 FROM json_each(NEW.document,'$.keyboard') WHERE key NOT IN ('buy','sellBalance','sellSupply'))
 OR json_type(NEW.document,'$.keyboard.buy') IS NOT 'array' OR json_array_length(NEW.document,'$.keyboard.buy')<>8
 OR json_type(NEW.document,'$.keyboard.sellBalance') IS NOT 'array' OR json_array_length(NEW.document,'$.keyboard.sellBalance')<>8
 OR json_type(NEW.document,'$.keyboard.sellSupply') IS NOT 'array' OR json_array_length(NEW.document,'$.keyboard.sellSupply')<>8
 OR EXISTS(SELECT 1 FROM json_each(NEW.document,'$.keyboard') groups JOIN json_each(groups.value) binding WHERE binding.type<>'text' OR (binding.value<>'' AND (length(binding.value)<>1 OR binding.value NOT GLOB '[a-z0-9]')))
 OR EXISTS(SELECT binding.value FROM json_each(NEW.document,'$.keyboard') groups JOIN json_each(groups.value) binding WHERE binding.value<>'' GROUP BY binding.value HAVING count(*)>1)
 )) THEN RAISE(ABORT,'Invalid presentation preset document') END;
END;
--> statement-breakpoint
CREATE TRIGGER trade_amount_preferences_update BEFORE UPDATE ON trade_amount_preferences BEGIN
 SELECT CASE WHEN NEW.owner_id IS NOT OLD.owner_id OR NEW.created_at IS NOT OLD.created_at OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
 OR NEW.updated_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ',NEW.updated_at)
 OR json_type(NEW.document)<>'object' OR (json_extract(NEW.document,'$.format') IS NOT 'trade-amount-presets-v1' AND json_extract(NEW.document,'$.format') IS NOT 'trade-amount-presets-v2')
 OR (SELECT count(*) FROM json_each(NEW.document))<> (4 + (json_extract(NEW.document,'$.format')='trade-amount-presets-v2'))
 OR EXISTS(SELECT 1 FROM json_each(NEW.document) WHERE key NOT IN ('format','buySol','sellBalanceBps','sellSupplyBps','keyboard'))
 OR json_type(NEW.document,'$.buySol') IS NOT 'array' OR json_array_length(NEW.document,'$.buySol') NOT BETWEEN 1 AND 8
 OR json_type(NEW.document,'$.sellBalanceBps') IS NOT 'array' OR json_array_length(NEW.document,'$.sellBalanceBps') NOT BETWEEN 1 AND 8
 OR json_type(NEW.document,'$.sellSupplyBps') IS NOT 'array' OR json_array_length(NEW.document,'$.sellSupplyBps') NOT BETWEEN 1 AND 8
 OR EXISTS(SELECT 1 FROM json_each(NEW.document,'$.buySol') WHERE type<>'text' OR length(value) NOT BETWEEN 1 AND 40)
 OR EXISTS(SELECT 1 FROM json_each(NEW.document,'$.sellBalanceBps') WHERE type<>'integer' OR value NOT BETWEEN 1 AND 10000)
 OR EXISTS(SELECT 1 FROM json_each(NEW.document,'$.sellSupplyBps') WHERE type<>'integer' OR value NOT BETWEEN 1 AND 10000)
 OR (json_extract(NEW.document,'$.format')='trade-amount-presets-v2' AND (
 json_type(NEW.document,'$.keyboard') IS NOT 'object'
 OR (SELECT count(*) FROM json_each(NEW.document,'$.keyboard'))<>3
 OR EXISTS(SELECT 1 FROM json_each(NEW.document,'$.keyboard') WHERE key NOT IN ('buy','sellBalance','sellSupply'))
 OR json_type(NEW.document,'$.keyboard.buy') IS NOT 'array' OR json_array_length(NEW.document,'$.keyboard.buy')<>8
 OR json_type(NEW.document,'$.keyboard.sellBalance') IS NOT 'array' OR json_array_length(NEW.document,'$.keyboard.sellBalance')<>8
 OR json_type(NEW.document,'$.keyboard.sellSupply') IS NOT 'array' OR json_array_length(NEW.document,'$.keyboard.sellSupply')<>8
 OR EXISTS(SELECT 1 FROM json_each(NEW.document,'$.keyboard') groups JOIN json_each(groups.value) binding WHERE binding.type<>'text' OR (binding.value<>'' AND (length(binding.value)<>1 OR binding.value NOT GLOB '[a-z0-9]')))
 OR EXISTS(SELECT binding.value FROM json_each(NEW.document,'$.keyboard') groups JOIN json_each(groups.value) binding WHERE binding.value<>'' GROUP BY binding.value HAVING count(*)>1)
 )) THEN RAISE(ABORT,'Invalid preset revision or presentation document') END;
END;
