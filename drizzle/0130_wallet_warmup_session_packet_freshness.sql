CREATE TRIGGER wallet_warmup_session_packets_fresh BEFORE INSERT ON wallet_warmup_session_packets BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_preparations p
 JOIN wallet_warmup_session_journals j ON j.owner_id=p.owner_id AND j.id=p.journal_id
 JOIN wallet_warmup_session_journal_heads h ON h.owner_id=p.owner_id AND h.journal_id=p.journal_id
 WHERE p.owner_id=NEW.owner_id AND p.preparation_id=NEW.preparation_id
 AND h.version=p.review_version AND h.head_sha256=p.review_sha256
 AND julianday(json_extract(p.preparation_document,'$.expiresAt'))>julianday('now')
 AND julianday(json_extract(j.source_document,'$.reviewExpiresAt'))>julianday('now'))
 THEN RAISE(ABORT,'Session packet context expired or changed') END;
END;
