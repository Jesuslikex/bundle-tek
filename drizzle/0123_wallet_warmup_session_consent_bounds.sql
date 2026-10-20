CREATE TRIGGER wallet_warmup_session_consents_bounds BEFORE INSERT ON wallet_warmup_session_consents BEGIN
 SELECT CASE WHEN strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) IS NOT NEW.created_at
 OR json_type(NEW.document,'$.sessionExpiresAt') IS NOT 'text'
 OR strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(NEW.document,'$.sessionExpiresAt')) IS NOT json_extract(NEW.document,'$.sessionExpiresAt')
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND json_array_length(r.document,'$.actions')>0
 AND json_extract(NEW.document,'$.sessionExpiresAt') <= (SELECT strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(json_extract(a.value,'$.scheduledAt'))),'+300 seconds') FROM json_each(r.document,'$.actions') a))
 THEN RAISE(ABORT,'Invalid warmup session consent deadline') END;
END;
