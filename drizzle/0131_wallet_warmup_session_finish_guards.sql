CREATE TRIGGER wallet_warmup_session_review_finish BEFORE INSERT ON wallet_warmup_session_journal_events WHEN json_extract(NEW.document,'$.operation')='begin-review' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_journals j JOIN wallet_warmup_session_consents c ON c.owner_id=j.owner_id AND c.id=j.consent_id
 WHERE j.owner_id=NEW.owner_id AND j.id=NEW.journal_id AND NEW.created_at<json_extract(c.document,'$.sessionExpiresAt') AND julianday(json_extract(c.document,'$.sessionExpiresAt'))>julianday('now'))
 THEN RAISE(ABORT,'Approved warmup session has finished') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_binding_finish BEFORE INSERT ON wallet_warmup_session_action_bindings BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_journals j JOIN wallet_warmup_session_consents c ON c.owner_id=j.owner_id AND c.id=j.consent_id
 WHERE j.owner_id=NEW.owner_id AND j.id=NEW.journal_id AND NEW.created_at<json_extract(c.document,'$.sessionExpiresAt') AND julianday(json_extract(c.document,'$.sessionExpiresAt'))>julianday('now'))
 THEN RAISE(ABORT,'Approved warmup session has finished') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_packet_finish BEFORE INSERT ON wallet_warmup_session_packets BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_preparations p JOIN wallet_warmup_session_journals j ON j.owner_id=p.owner_id AND j.id=p.journal_id JOIN wallet_warmup_session_consents c ON c.owner_id=j.owner_id AND c.id=j.consent_id
 WHERE p.owner_id=NEW.owner_id AND p.preparation_id=NEW.preparation_id AND julianday(json_extract(c.document,'$.sessionExpiresAt'))>julianday('now'))
 THEN RAISE(ABORT,'Approved warmup session has finished') END;
END;
