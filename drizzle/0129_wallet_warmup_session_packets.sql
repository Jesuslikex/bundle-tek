CREATE TABLE wallet_warmup_session_packets (
 owner_id TEXT NOT NULL,preparation_id TEXT NOT NULL,preparation_sha256 TEXT NOT NULL,
 unsigned_transaction TEXT NOT NULL,packet_sha256 TEXT NOT NULL,record_sha256 TEXT NOT NULL,
 PRIMARY KEY(owner_id,preparation_id),
 FOREIGN KEY(owner_id,preparation_id) REFERENCES wallet_warmup_session_preparations(owner_id,preparation_id)
);
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_packets_insert BEFORE INSERT ON wallet_warmup_session_packets BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM wallet_warmup_session_packets p WHERE p.owner_id=NEW.owner_id AND p.preparation_id=NEW.preparation_id)
 OR length(NEW.unsigned_transaction) NOT BETWEEN 1 AND 1644
 OR length(NEW.record_sha256)!=64 OR NEW.record_sha256 GLOB '*[^a-f0-9]*'
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_session_preparations p WHERE p.owner_id=NEW.owner_id AND p.preparation_id=NEW.preparation_id AND p.record_sha256=NEW.preparation_sha256 AND json_extract(p.preparation_document,'$.transaction.sha256')=NEW.packet_sha256)
 THEN RAISE(ABORT,'Session packet identity changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_packets_no_update BEFORE UPDATE ON wallet_warmup_session_packets BEGIN SELECT RAISE(ABORT,'Session packets are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_packets_no_delete BEFORE DELETE ON wallet_warmup_session_packets BEGIN SELECT RAISE(ABORT,'Session packets are immutable'); END;

