CREATE TABLE wallet_warmup_session_journals (
 owner_id TEXT NOT NULL, id TEXT NOT NULL, consent_id TEXT NOT NULL,
 terms_sha256 TEXT NOT NULL, started_at TEXT NOT NULL,
 source_document TEXT NOT NULL CHECK(json_valid(source_document)),
 source_sha256 TEXT NOT NULL, initial_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,id), UNIQUE(owner_id,consent_id),
 FOREIGN KEY(owner_id,consent_id) REFERENCES wallet_warmup_session_consents(owner_id,id)
);
--> statement-breakpoint
CREATE TABLE wallet_warmup_session_journal_events (
 owner_id TEXT NOT NULL, journal_id TEXT NOT NULL, id TEXT NOT NULL,
 version INTEGER NOT NULL, previous_sha256 TEXT NOT NULL,
 document TEXT NOT NULL CHECK(json_valid(document)), event_sha256 TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,id), UNIQUE(owner_id,journal_id,version),
 FOREIGN KEY(owner_id,journal_id) REFERENCES wallet_warmup_session_journals(owner_id,id)
);
--> statement-breakpoint
CREATE TABLE wallet_warmup_session_journal_heads (
 owner_id TEXT NOT NULL,journal_id TEXT NOT NULL,version INTEGER NOT NULL,
 head_sha256 TEXT NOT NULL,document_bytes INTEGER NOT NULL,updated_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,journal_id),
 FOREIGN KEY(owner_id,journal_id) REFERENCES wallet_warmup_session_journals(owner_id,id)
);
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_journals_insert BEFORE INSERT ON wallet_warmup_session_journals BEGIN
 SELECT CASE WHEN length(NEW.owner_id) NOT BETWEEN 1 AND 128
 OR length(NEW.id)!=36 OR NEW.id GLOB '*[^a-f0-9-]*' OR length(replace(NEW.id,'-',''))!=32
 OR substr(NEW.id,9,1)!='-' OR substr(NEW.id,14,1)!='-' OR substr(NEW.id,19,1)!='-' OR substr(NEW.id,24,1)!='-'
 OR length(NEW.source_sha256)!=64 OR NEW.source_sha256 GLOB '*[^a-f0-9]*'
 OR length(NEW.initial_sha256)!=64 OR NEW.initial_sha256 GLOB '*[^a-f0-9]*'
 OR length(CAST(NEW.source_document AS BLOB))>1572864
 OR (SELECT count(*) FROM json_each(NEW.source_document))!=2
 OR json_type(NEW.source_document,'$.review') IS NOT 'object'
 OR json_type(NEW.source_document,'$.review.contextKey') IS NOT 'text'
 OR json_type(NEW.source_document,'$.review.executionAllowed') IS NOT 'false'
 OR json_type(NEW.source_document,'$.review.signingAllowed') IS NOT 'false'
 OR json_type(NEW.source_document,'$.review.automaticExecutionAllowed') IS NOT 'false'
 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) IS NOT NEW.created_at
 OR NEW.created_at<NEW.started_at
 OR EXISTS(SELECT 1 FROM wallet_warmup_session_journals WHERE owner_id=NEW.owner_id AND (id=NEW.id OR consent_id=NEW.consent_id))
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_session_consents c JOIN wallet_warmup_session_reviews r ON r.owner_id=c.owner_id AND r.id=c.review_id
 WHERE c.owner_id=NEW.owner_id AND c.id=NEW.consent_id AND c.terms_sha256=NEW.terms_sha256
 AND c.created_at=NEW.started_at
 AND json_extract(c.document,'$.reviewDocument')=r.document
 AND json_extract(NEW.source_document,'$.reviewExpiresAt')=r.review_expires_at
 AND json_extract(NEW.source_document,'$.review.reviewedAt')=r.reviewed_at
 AND json_extract(NEW.source_document,'$.review.planId')=r.plan_id
 AND json_extract(NEW.source_document,'$.review.planRevision')=r.plan_revision
 AND json_type(c.document,'$.executionAllowed')='false'
 AND json_type(c.document,'$.signingAllowed')='false'
 AND json_type(c.document,'$.automaticExecutionAllowed')='false')
 THEN RAISE(ABORT,'Invalid warmup recovery journal') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_journals_no_update BEFORE UPDATE ON wallet_warmup_session_journals BEGIN SELECT RAISE(ABORT,'Warmup recovery journals are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_journals_no_delete BEFORE DELETE ON wallet_warmup_session_journals BEGIN SELECT RAISE(ABORT,'Warmup recovery journals are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_journal_heads_insert BEFORE INSERT ON wallet_warmup_session_journal_heads BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM wallet_warmup_session_journal_heads WHERE owner_id=NEW.owner_id AND journal_id=NEW.journal_id)
 OR NEW.version!=0 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_session_journals j WHERE j.owner_id=NEW.owner_id AND j.id=NEW.journal_id AND j.initial_sha256=NEW.head_sha256 AND j.started_at=NEW.updated_at AND length(CAST(j.source_document AS BLOB))=NEW.document_bytes)
 OR EXISTS(SELECT 1 FROM wallet_warmup_session_journal_events WHERE owner_id=NEW.owner_id AND journal_id=NEW.journal_id)
 THEN RAISE(ABORT,'Invalid warmup journal head') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_journal_heads_update BEFORE UPDATE ON wallet_warmup_session_journal_heads BEGIN
 SELECT CASE WHEN NEW.owner_id!=OLD.owner_id OR NEW.journal_id!=OLD.journal_id OR NEW.version!=OLD.version+1
 OR NEW.version!=(SELECT count(*) FROM wallet_warmup_session_journal_events WHERE owner_id=OLD.owner_id AND journal_id=OLD.journal_id)
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_session_journal_events e WHERE e.owner_id=OLD.owner_id AND e.journal_id=OLD.journal_id AND e.version=NEW.version AND e.previous_sha256=OLD.head_sha256 AND e.event_sha256=NEW.head_sha256 AND e.created_at=NEW.updated_at AND NEW.document_bytes=OLD.document_bytes+length(CAST(e.document AS BLOB)))
 THEN RAISE(ABORT,'Warmup journal head transition changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_journal_heads_no_delete BEFORE DELETE ON wallet_warmup_session_journal_heads BEGIN SELECT RAISE(ABORT,'Warmup journal head is retained'); END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_journals_head AFTER INSERT ON wallet_warmup_session_journals BEGIN
 INSERT INTO wallet_warmup_session_journal_heads VALUES(NEW.owner_id,NEW.id,0,NEW.initial_sha256,length(CAST(NEW.source_document AS BLOB)),NEW.started_at);
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_journal_events_insert BEFORE INSERT ON wallet_warmup_session_journal_events BEGIN
 SELECT CASE WHEN length(NEW.id)!=36 OR NEW.id GLOB '*[^a-f0-9-]*' OR length(replace(NEW.id,'-',''))!=32
 OR substr(NEW.id,9,1)!='-' OR substr(NEW.id,14,1)!='-' OR substr(NEW.id,19,1)!='-' OR substr(NEW.id,24,1)!='-'
 OR typeof(NEW.version)!='integer' OR NEW.version NOT BETWEEN 1 AND 4096
 OR length(NEW.event_sha256)!=64 OR NEW.event_sha256 GLOB '*[^a-f0-9]*'
 OR length(CAST(NEW.document AS BLOB))>1048576
 OR json_type(NEW.document,'$.version') IS NOT 'integer' OR json_extract(NEW.document,'$.version') IS NOT NEW.version
 OR json_extract(NEW.document,'$.eventId') IS NOT NEW.id
 OR json_extract(NEW.document,'$.previousSha256') IS NOT NEW.previous_sha256
 OR json_extract(NEW.document,'$.at') IS NOT NEW.created_at
 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) IS NOT NEW.created_at
 OR json_extract(NEW.document,'$.operation') IS NULL
 OR json_extract(NEW.document,'$.operation') NOT IN ('begin-review','submitted','unknown','pause','resume','stop')
 OR (SELECT count(*) FROM json_each(NEW.document))!= CASE WHEN json_extract(NEW.document,'$.operation') IN ('begin-review','submitted','unknown') THEN 6 ELSE 5 END
 OR (json_extract(NEW.document,'$.operation') IN ('begin-review','submitted','unknown') AND (json_type(NEW.document,'$.actionId') IS NOT 'text' OR length(json_extract(NEW.document,'$.actionId')) NOT BETWEEN 1 AND 1024))
 OR EXISTS(SELECT 1 FROM wallet_warmup_session_journal_events WHERE owner_id=NEW.owner_id AND id=NEW.id)
 OR (json_extract(NEW.document,'$.operation')='begin-review' AND NOT EXISTS(SELECT 1 FROM wallet_warmup_session_journals j WHERE j.owner_id=NEW.owner_id AND j.id=NEW.journal_id AND NEW.created_at<json_extract(j.source_document,'$.reviewExpiresAt') AND julianday('now')<julianday(json_extract(j.source_document,'$.reviewExpiresAt'))))
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_session_journals j JOIN wallet_warmup_session_journal_heads h ON h.owner_id=j.owner_id AND h.journal_id=j.id WHERE j.owner_id=NEW.owner_id AND j.id=NEW.journal_id
 AND NEW.version=h.version+1 AND NEW.previous_sha256=h.head_sha256
 AND NEW.version=1+COALESCE((SELECT max(e.version) FROM wallet_warmup_session_journal_events e WHERE e.owner_id=NEW.owner_id AND e.journal_id=NEW.journal_id),0)
 AND NEW.previous_sha256=COALESCE((SELECT e.event_sha256 FROM wallet_warmup_session_journal_events e WHERE e.owner_id=NEW.owner_id AND e.journal_id=NEW.journal_id ORDER BY e.version DESC LIMIT 1),j.initial_sha256)
 AND NEW.created_at>=COALESCE((SELECT e.created_at FROM wallet_warmup_session_journal_events e WHERE e.owner_id=NEW.owner_id AND e.journal_id=NEW.journal_id ORDER BY e.version DESC LIMIT 1),j.started_at)
 AND length(CAST(j.source_document AS BLOB))+length(CAST(NEW.document AS BLOB))+COALESCE((SELECT sum(length(CAST(e.document AS BLOB))) FROM wallet_warmup_session_journal_events e WHERE e.owner_id=NEW.owner_id AND e.journal_id=NEW.journal_id),0)<=4194304)
 THEN RAISE(ABORT,'Warmup journal predecessor changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_journal_events_head AFTER INSERT ON wallet_warmup_session_journal_events BEGIN
 UPDATE wallet_warmup_session_journal_heads SET version=NEW.version,head_sha256=NEW.event_sha256,document_bytes=document_bytes+length(CAST(NEW.document AS BLOB)),updated_at=NEW.created_at WHERE owner_id=NEW.owner_id AND journal_id=NEW.journal_id;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_journal_heads WHERE owner_id=NEW.owner_id AND journal_id=NEW.journal_id AND version=NEW.version AND head_sha256=NEW.event_sha256) THEN RAISE(ABORT,'Warmup journal head did not advance') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_journal_events_no_update BEFORE UPDATE ON wallet_warmup_session_journal_events BEGIN SELECT RAISE(ABORT,'Warmup journal events are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_journal_events_no_delete BEFORE DELETE ON wallet_warmup_session_journal_events BEGIN SELECT RAISE(ABORT,'Warmup journal events are immutable'); END;
