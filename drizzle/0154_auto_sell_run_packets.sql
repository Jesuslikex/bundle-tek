CREATE TABLE auto_sell_run_packets (
 owner_id TEXT NOT NULL,run_id TEXT NOT NULL,attempt_id TEXT NOT NULL,preparation_id TEXT NOT NULL UNIQUE,
 run_sha256 TEXT NOT NULL CHECK(length(run_sha256)=64 AND run_sha256 NOT GLOB '*[^0-9a-f]*'),
 attempt_sha256 TEXT NOT NULL CHECK(length(attempt_sha256)=64 AND attempt_sha256 NOT GLOB '*[^0-9a-f]*'),
 project_id TEXT NOT NULL,project_revision INTEGER NOT NULL CHECK(typeof(project_revision)='integer' AND project_revision BETWEEN 1 AND 1000000000),
 wallet TEXT NOT NULL,wallet_revision INTEGER NOT NULL CHECK(typeof(wallet_revision)='integer' AND wallet_revision BETWEEN 1 AND 1000000000),
 packet_sha256 TEXT NOT NULL CHECK(length(packet_sha256)=64 AND packet_sha256 NOT GLOB '*[^0-9a-f]*'),
 summary_sha256 TEXT NOT NULL CHECK(length(summary_sha256)=64 AND summary_sha256 NOT GLOB '*[^0-9a-f]*'),
 summary_document TEXT NOT NULL CHECK(json_valid(summary_document) AND length(CAST(summary_document AS BLOB))<=32768),
 transaction_text TEXT NOT NULL CHECK(length(transaction_text) BETWEEN 1 AND 1644),
 packet_bytes INTEGER NOT NULL CHECK(typeof(packet_bytes)='integer' AND packet_bytes BETWEEN 1 AND 1232),
 document TEXT NOT NULL CHECK(json_valid(document) AND length(CAST(document AS BLOB))<=8192),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
 created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,attempt_id),
 FOREIGN KEY(owner_id,attempt_id) REFERENCES auto_sell_run_attempts(owner_id,id),
 FOREIGN KEY(preparation_id) REFERENCES imported_swap_preparations(id)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX auto_sell_run_packets_run ON auto_sell_run_packets(owner_id,run_id,attempt_id);
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_packets_insert BEFORE INSERT ON auto_sell_run_packets BEGIN
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'Auto Sell packet requires its new original preparation') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM auto_sell_run_packets WHERE (owner_id=NEW.owner_id AND attempt_id=NEW.attempt_id) OR preparation_id=NEW.preparation_id)
 THEN RAISE(ABORT,'Auto Sell packet already retained') END;
 SELECT CASE WHEN (SELECT count(*) FROM auto_sell_run_packets WHERE owner_id=NEW.owner_id AND run_id=NEW.run_id)>=1000
 OR COALESCE((SELECT sum(length(CAST(document AS BLOB))+length(CAST(summary_document AS BLOB))+length(CAST(transaction_text AS BLOB))) FROM auto_sell_run_packets WHERE owner_id=NEW.owner_id AND run_id=NEW.run_id),0)
  +length(CAST(NEW.document AS BLOB))+length(CAST(NEW.summary_document AS BLOB))+length(CAST(NEW.transaction_text AS BLOB))>33554432
 THEN RAISE(ABORT,'Auto Sell packet history full') END;
 SELECT CASE WHEN json_type(NEW.document) IS NOT 'object' OR (SELECT count(*) FROM json_each(NEW.document))!=19
 OR json_extract(NEW.document,'$.format') IS NOT 'auto-sell-run-packet-v1'
 OR json_type(NEW.document,'$.signingAllowed') IS NOT 'false' OR json_type(NEW.document,'$.executionAllowed') IS NOT 'false' OR json_type(NEW.document,'$.automaticResumeAllowed') IS NOT 'false'
 OR json_extract(NEW.document,'$.runId') IS NOT NEW.run_id OR json_extract(NEW.document,'$.attemptId') IS NOT NEW.attempt_id OR json_extract(NEW.document,'$.preparationId') IS NOT NEW.preparation_id
 OR json_extract(NEW.document,'$.runSha256') IS NOT NEW.run_sha256 OR json_extract(NEW.document,'$.attemptSha256') IS NOT NEW.attempt_sha256
 OR json_extract(NEW.document,'$.projectId') IS NOT NEW.project_id OR json_extract(NEW.document,'$.projectRevision') IS NOT NEW.project_revision
 OR json_extract(NEW.document,'$.wallet') IS NOT NEW.wallet OR json_extract(NEW.document,'$.walletRevision') IS NOT NEW.wallet_revision
 OR json_extract(NEW.document,'$.packetSha256') IS NOT NEW.packet_sha256 OR json_extract(NEW.document,'$.summarySha256') IS NOT NEW.summary_sha256
 OR json_extract(NEW.document,'$.transaction') IS NOT NEW.transaction_text OR json_extract(NEW.document,'$.packetBytes') IS NOT NEW.packet_bytes
 OR json_extract(NEW.document,'$.createdAt') IS NOT NEW.created_at OR json_extract(NEW.document,'$.sha256') IS NOT NEW.sha256
 THEN RAISE(ABORT,'Auto Sell packet record invalid') END;
 SELECT CASE WHEN length(NEW.created_at)!=24 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) IS NOT NEW.created_at
 OR NEW.created_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 seconds') OR NEW.created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 seconds')
 THEN RAISE(ABORT,'Auto Sell packet clock invalid') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM auto_sell_runs r JOIN auto_sell_run_attempts a ON a.owner_id=r.owner_id AND a.run_id=r.id
 JOIN auto_sell_run_preparation_starts s ON s.owner_id=a.owner_id AND s.attempt_id=a.id
 JOIN auto_sell_run_heads h ON h.owner_id=r.owner_id AND h.run_id=r.id
 JOIN imported_swap_preparations p ON p.owner_id=a.owner_id AND p.id=a.preparation_id
 WHERE r.owner_id=NEW.owner_id AND r.id=NEW.run_id AND a.id=NEW.attempt_id AND a.preparation_id=NEW.preparation_id
 AND r.sha256=NEW.run_sha256 AND a.sha256=NEW.attempt_sha256 AND h.state='open'
 AND s.preparation_id=a.preparation_id AND s.head_sequence=h.sequence AND s.head_sha256=h.head_sha256
 AND p.project_id=NEW.project_id AND p.project_revision=NEW.project_revision AND p.wallet_address=NEW.wallet AND p.wallet_revision=NEW.wallet_revision
 AND p.document IS NEW.summary_document AND a.wallet=NEW.wallet AND a.wallet_revision=NEW.wallet_revision
 AND json_extract(p.document,'$.transaction.sha256') IS NEW.packet_sha256 AND json_extract(p.document,'$.transaction.bytes') IS NEW.packet_bytes
 AND json_extract(p.document,'$.inAmountRaw') IS a.input_raw AND json_type(p.document,'$.executionAllowed') IS 'false'
 AND julianday(json_extract(p.document,'$.expiresAt'))>julianday('now')
 ) THEN RAISE(ABORT,'Auto Sell packet original source differs') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM auto_sell_run_current_sources c WHERE c.owner_id=NEW.owner_id AND c.id=NEW.run_id)
 OR EXISTS(SELECT 1 FROM auto_sell_run_stops s WHERE s.owner_id=NEW.owner_id AND s.run_id=NEW.run_id)
 THEN RAISE(ABORT,'Auto Sell packet run changed or stopped') END;
END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_packets_no_update BEFORE UPDATE ON auto_sell_run_packets BEGIN
 SELECT RAISE(ABORT,'Auto Sell original packets are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_packets_no_delete BEFORE DELETE ON auto_sell_run_packets BEGIN
 SELECT RAISE(ABORT,'Auto Sell original packets are retained');
END;
