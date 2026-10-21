CREATE TRIGGER wallet_warmup_session_action_bindings_fresh BEFORE INSERT ON wallet_warmup_session_action_bindings BEGIN
 SELECT CASE WHEN json_type(NEW.preparation_document,'$.simulation.succeeded') IS NOT 'true'
 OR json_type(NEW.preparation_document,'$.executionAllowed') IS NOT 'false'
 OR json_type(NEW.preparation_document,'$.instructionsVerified') IS NOT 'false'
 OR json_extract(NEW.preparation_document,'$.chain') IS NOT 'Solana'
 OR strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(NEW.preparation_document,'$.expiresAt')) IS NOT json_extract(NEW.preparation_document,'$.expiresAt')
 OR NOT (julianday(json_extract(NEW.preparation_document,'$.expiresAt'))>julianday(NEW.created_at))
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_session_journals j WHERE j.owner_id=NEW.owner_id AND j.id=NEW.journal_id
 AND julianday('now')<julianday(json_extract(j.source_document,'$.reviewExpiresAt'))
 AND julianday('now')<julianday(json_extract(NEW.preparation_document,'$.expiresAt')))
 THEN RAISE(ABORT,'Unsigned action preparation or review expired or is unusable') END;
END;
