CREATE TABLE jito_bundle_protocol (
 owner_id TEXT NOT NULL, bundle_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version=2),
 manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'), created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,bundle_id)
);
--> statement-breakpoint
CREATE TABLE jito_sign_attempts (
 owner_id TEXT NOT NULL, bundle_id TEXT NOT NULL, packet INTEGER NOT NULL CHECK(packet BETWEEN 0 AND 4),
 attempt_id TEXT NOT NULL CHECK(length(attempt_id)=36), manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
 signer TEXT NOT NULL CHECK(length(signer) BETWEEN 32 AND 44), intent_id TEXT, created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,bundle_id,packet), UNIQUE(owner_id,attempt_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX jito_sign_attempt_intent ON jito_sign_attempts(owner_id,intent_id) WHERE intent_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE jito_sign_receipts (
 owner_id TEXT NOT NULL, bundle_id TEXT NOT NULL, packet INTEGER NOT NULL,
 attempt_id TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, signer TEXT NOT NULL, intent_id TEXT,
 `transaction` TEXT NOT NULL CHECK(length(`transaction`) BETWEEN 1 AND 1644), signature TEXT NOT NULL CHECK(length(signature) BETWEEN 1 AND 128),
 created_at TEXT NOT NULL, PRIMARY KEY(owner_id,bundle_id,packet), UNIQUE(owner_id,attempt_id)
);
--> statement-breakpoint
CREATE TRIGGER jito_protocol_insert BEFORE INSERT ON jito_bundle_protocol BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM jito_bundles b WHERE b.owner_id=NEW.owner_id AND b.id=NEW.bundle_id AND b.state='reviewed' AND json_type(b.document,'$.sha256')='text' AND json_extract(b.document,'$.sha256')=NEW.manifest_sha256 AND NOT EXISTS(SELECT 1 FROM jito_bundle_packets p WHERE p.owner_id=b.owner_id AND p.bundle_id=b.id)) THEN RAISE(ABORT,'Bundle protocol requires a new exact manifest') END;
END;
--> statement-breakpoint
CREATE TRIGGER jito_protocol_update BEFORE UPDATE ON jito_bundle_protocol BEGIN SELECT RAISE(ABORT,'Bundle protocol is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER jito_protocol_delete BEFORE DELETE ON jito_bundle_protocol BEGIN SELECT RAISE(ABORT,'Bundle protocol is retained'); END;
--> statement-breakpoint
CREATE TRIGGER jito_v2_packet_insert BEFORE INSERT ON jito_bundle_packets BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM jito_bundle_protocol v JOIN jito_bundles b ON b.owner_id=v.owner_id AND b.id=v.bundle_id WHERE v.owner_id=NEW.owner_id AND v.bundle_id=NEW.bundle_id AND v.version=2 AND v.manifest_sha256=json_extract(b.document,'$.sha256')) THEN RAISE(ABORT,'Bundle client upgrade required') END;
END;
--> statement-breakpoint
CREATE TRIGGER jito_attempt_insert BEFORE INSERT ON jito_sign_attempts BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM jito_bundles b JOIN jito_bundle_protocol v ON v.owner_id=b.owner_id AND v.bundle_id=b.id JOIN jito_bundle_packets p ON p.owner_id=b.owner_id AND p.bundle_id=b.id AND p.packet=NEW.packet
  JOIN imported_trade_sessions s ON s.owner_id=b.owner_id AND s.id=b.session_id AND s.project_id=b.project_id JOIN imported_trade_session_controls c ON c.owner_id=s.owner_id AND c.session_id=s.id
  WHERE b.owner_id=NEW.owner_id AND b.id=NEW.bundle_id AND b.state='reviewed' AND v.version=2 AND v.manifest_sha256=NEW.manifest_sha256 AND json_extract(b.document,'$.sha256')=NEW.manifest_sha256 AND p.intent_id IS NEW.intent_id AND p.signature IS NULL AND p.`transaction` IS NULL
   AND julianday(json_extract(b.document,'$.expiresAt'))>julianday('now') AND s.state='active' AND s.revision=json_extract(b.document,'$.sessionRevision') AND c.state='ready'
   AND ((NEW.packet=json_array_length(b.document,'$.swaps') AND NEW.intent_id IS NULL AND json_type(b.document,'$.tip.wallet')='text' AND NEW.signer=json_extract(b.document,'$.tip.wallet') AND NEW.signer=json_extract(b.document,'$.swaps[0].wallet') AND EXISTS(
     SELECT 1 FROM imported_swap_signing_intents i JOIN imported_swap_preparations pr ON pr.owner_id=i.owner_id AND pr.id=i.preparation_id JOIN imported_token_projects t ON t.owner_id=pr.owner_id AND t.id=pr.project_id JOIN workspace_wallets w ON w.owner_id=pr.owner_id AND w.address=i.wallet_address AND w.chain='Solana' JOIN solana_swap_reservations r ON r.owner_id=i.owner_id AND r.wallet_address=i.wallet_address JOIN solana_execution_reservations e ON e.owner_id=r.owner_id AND e.wallet_address=r.wallet_address
     WHERE i.owner_id=b.owner_id AND i.id=json_extract(b.document,'$.swaps[0].id') AND i.wallet_address=NEW.signer AND i.document=json_extract(b.document,'$.swaps[0]') AND i.state IN ('awaiting_signature','signed') AND pr.project_id=b.project_id AND t.revision=pr.project_revision AND t.archived=0 AND w.revision=pr.wallet_revision AND w.archived=0 AND r.scope='imported' AND r.intent_id=i.id AND r.state=i.state AND e.scope=r.scope AND e.intent_id=r.intent_id AND e.state=r.state AND julianday(json_extract(i.document,'$.expiresAt'))>julianday('now')
    )) OR
    (NEW.packet<json_array_length(b.document,'$.swaps') AND NEW.intent_id IS NOT NULL AND json_type(b.document,'$.swaps['||NEW.packet||'].wallet')='text' AND NEW.signer=json_extract(b.document,'$.swaps['||NEW.packet||'].wallet') AND EXISTS(
     SELECT 1 FROM imported_swap_signing_intents i JOIN imported_swap_preparations pr ON pr.owner_id=i.owner_id AND pr.id=i.preparation_id JOIN imported_token_projects t ON t.owner_id=pr.owner_id AND t.id=pr.project_id JOIN workspace_wallets w ON w.owner_id=pr.owner_id AND w.address=i.wallet_address AND w.chain='Solana' JOIN solana_swap_reservations r ON r.owner_id=i.owner_id AND r.wallet_address=i.wallet_address JOIN solana_execution_reservations e ON e.owner_id=r.owner_id AND e.wallet_address=r.wallet_address
     WHERE i.owner_id=b.owner_id AND i.id=NEW.intent_id AND i.wallet_address=NEW.signer AND i.state='awaiting_signature' AND i.signature IS NULL AND i.document=json_extract(b.document,'$.swaps['||NEW.packet||']') AND pr.project_id=b.project_id AND t.revision=pr.project_revision AND t.archived=0 AND w.revision=pr.wallet_revision AND w.archived=0 AND r.scope='imported' AND r.intent_id=i.id AND r.state='awaiting_signature' AND e.scope=r.scope AND e.intent_id=r.intent_id AND e.state=r.state AND julianday(json_extract(i.document,'$.expiresAt'))>julianday('now')
    )))
 ) THEN RAISE(ABORT,'Signing attempt context differs') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM jito_sign_attempts a WHERE a.owner_id=NEW.owner_id AND (a.bundle_id=NEW.bundle_id OR a.signer=NEW.signer OR (a.intent_id IS NOT NULL AND a.intent_id=NEW.intent_id)) AND NOT EXISTS(SELECT 1 FROM jito_sign_receipts r WHERE r.owner_id=a.owner_id AND r.bundle_id=a.bundle_id AND r.packet=a.packet)) THEN RAISE(ABORT,'Signing attempt outcome is unknown') END;
END;
--> statement-breakpoint
CREATE TRIGGER jito_attempt_update BEFORE UPDATE ON jito_sign_attempts BEGIN SELECT RAISE(ABORT,'Signing attempt is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER jito_attempt_delete BEFORE DELETE ON jito_sign_attempts BEGIN SELECT RAISE(ABORT,'Signing attempt is retained'); END;
--> statement-breakpoint
CREATE TRIGGER jito_receipt_insert BEFORE INSERT ON jito_sign_receipts BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM jito_sign_attempts a JOIN jito_bundle_protocol v ON v.owner_id=a.owner_id AND v.bundle_id=a.bundle_id JOIN jito_bundles b ON b.owner_id=a.owner_id AND b.id=a.bundle_id JOIN jito_bundle_packets p ON p.owner_id=a.owner_id AND p.bundle_id=a.bundle_id AND p.packet=a.packet WHERE a.owner_id=NEW.owner_id AND a.bundle_id=NEW.bundle_id AND a.packet=NEW.packet AND a.attempt_id=NEW.attempt_id AND a.manifest_sha256=NEW.manifest_sha256 AND a.signer=NEW.signer AND a.intent_id IS NEW.intent_id AND v.manifest_sha256=NEW.manifest_sha256 AND json_extract(b.document,'$.sha256')=NEW.manifest_sha256 AND b.state='reviewed' AND p.intent_id IS NEW.intent_id AND p.signature IS NULL AND p.`transaction` IS NULL) THEN RAISE(ABORT,'Signing receipt context differs') END;
END;
--> statement-breakpoint
CREATE TRIGGER jito_receipt_apply AFTER INSERT ON jito_sign_receipts BEGIN
 UPDATE imported_swap_signing_intents SET state='signed',signature=NEW.signature,updated_at=NEW.created_at WHERE NEW.intent_id IS NOT NULL AND owner_id=NEW.owner_id AND id=NEW.intent_id AND wallet_address=NEW.signer AND state='awaiting_signature' AND signature IS NULL AND document=(SELECT json_extract(document,'$.swaps['||NEW.packet||']') FROM jito_bundles WHERE owner_id=NEW.owner_id AND id=NEW.bundle_id);
 SELECT CASE WHEN NEW.intent_id IS NOT NULL AND changes()<>1 THEN RAISE(ABORT,'Signing intent changed') END;
 UPDATE jito_bundle_packets SET `transaction`=NEW.`transaction`,signature=NEW.signature WHERE owner_id=NEW.owner_id AND bundle_id=NEW.bundle_id AND packet=NEW.packet AND intent_id IS NEW.intent_id AND signature IS NULL AND `transaction` IS NULL;
 SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'Signing packet changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER jito_receipt_update BEFORE UPDATE ON jito_sign_receipts BEGIN SELECT RAISE(ABORT,'Signing receipt is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER jito_receipt_delete BEFORE DELETE ON jito_sign_receipts BEGIN SELECT RAISE(ABORT,'Signing receipt is retained'); END;
--> statement-breakpoint
CREATE TRIGGER jito_v2_packet_signature BEFORE UPDATE OF signature,`transaction` ON jito_bundle_packets WHEN NEW.signature IS NOT OLD.signature OR NEW.`transaction` IS NOT OLD.`transaction` BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM jito_sign_receipts r WHERE r.owner_id=NEW.owner_id AND r.bundle_id=NEW.bundle_id AND r.packet=NEW.packet AND r.intent_id IS NEW.intent_id AND r.signature=NEW.signature AND r.`transaction`=NEW.`transaction`) THEN RAISE(ABORT,'Signing receipt required') END;
END;
--> statement-breakpoint
CREATE TRIGGER jito_v2_intent_signature BEFORE UPDATE OF signature ON imported_swap_signing_intents WHEN NEW.signature IS NOT OLD.signature AND EXISTS(SELECT 1 FROM jito_bundle_packets p WHERE p.owner_id=OLD.owner_id AND p.intent_id=OLD.id) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM jito_sign_receipts r WHERE r.owner_id=OLD.owner_id AND r.intent_id=OLD.id AND r.signature=NEW.signature) THEN RAISE(ABORT,'Signing receipt required') END;
END;
--> statement-breakpoint
CREATE TRIGGER jito_v2_bundle_transition BEFORE UPDATE OF state ON jito_bundles WHEN NEW.state<>OLD.state AND NEW.state IN ('cancelled','expired','submitting') BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM jito_bundle_protocol v WHERE v.owner_id=OLD.owner_id AND v.bundle_id=OLD.id) OR EXISTS(SELECT 1 FROM jito_sign_attempts a WHERE a.owner_id=OLD.owner_id AND a.bundle_id=OLD.id AND NOT EXISTS(SELECT 1 FROM jito_sign_receipts r WHERE r.owner_id=a.owner_id AND r.bundle_id=a.bundle_id AND r.packet=a.packet)) THEN RAISE(ABORT,'Bundle signing outcome requires recovery') END;
END;
--> statement-breakpoint
CREATE TRIGGER jito_v2_intent_state BEFORE UPDATE OF state ON imported_swap_signing_intents WHEN NEW.state<>OLD.state AND EXISTS(SELECT 1 FROM jito_bundle_packets p JOIN jito_bundles b ON b.owner_id=p.owner_id AND b.id=p.bundle_id WHERE p.owner_id=OLD.owner_id AND p.intent_id=OLD.id AND b.state IN ('reviewed','submitting','submitted') AND (NOT EXISTS(SELECT 1 FROM jito_bundle_protocol v WHERE v.owner_id=b.owner_id AND v.bundle_id=b.id) OR EXISTS(SELECT 1 FROM jito_sign_attempts a WHERE a.owner_id=b.owner_id AND a.bundle_id=b.id AND NOT EXISTS(SELECT 1 FROM jito_sign_receipts r WHERE r.owner_id=a.owner_id AND r.bundle_id=a.bundle_id AND r.packet=a.packet)))) BEGIN
 SELECT CASE WHEN NOT (NEW.state='signed' AND EXISTS(SELECT 1 FROM jito_sign_receipts r WHERE r.owner_id=OLD.owner_id AND r.intent_id=OLD.id AND r.signature=NEW.signature)) THEN RAISE(ABORT,'Bundle signing outcome requires recovery') END;
END;
--> statement-breakpoint
CREATE TRIGGER jito_v2_swap_reservation_delete BEFORE DELETE ON solana_swap_reservations WHEN EXISTS(SELECT 1 FROM jito_bundle_packets p JOIN jito_bundles b ON b.owner_id=p.owner_id AND b.id=p.bundle_id JOIN imported_swap_signing_intents i ON i.owner_id=p.owner_id AND i.id=p.intent_id WHERE i.owner_id=OLD.owner_id AND i.id=OLD.intent_id AND i.wallet_address=OLD.wallet_address AND b.state IN ('reviewed','submitting','submitted') AND (NOT EXISTS(SELECT 1 FROM jito_bundle_protocol v WHERE v.owner_id=b.owner_id AND v.bundle_id=b.id) OR EXISTS(SELECT 1 FROM jito_sign_attempts a WHERE a.owner_id=b.owner_id AND a.bundle_id=b.id AND NOT EXISTS(SELECT 1 FROM jito_sign_receipts r WHERE r.owner_id=a.owner_id AND r.bundle_id=a.bundle_id AND r.packet=a.packet)))) BEGIN SELECT RAISE(ABORT,'Bundle signing reservation is retained'); END;
--> statement-breakpoint
CREATE TRIGGER jito_v2_execution_reservation_delete BEFORE DELETE ON solana_execution_reservations WHEN EXISTS(SELECT 1 FROM jito_bundle_packets p JOIN jito_bundles b ON b.owner_id=p.owner_id AND b.id=p.bundle_id JOIN imported_swap_signing_intents i ON i.owner_id=p.owner_id AND i.id=p.intent_id WHERE i.owner_id=OLD.owner_id AND i.id=OLD.intent_id AND i.wallet_address=OLD.wallet_address AND b.state IN ('reviewed','submitting','submitted') AND (NOT EXISTS(SELECT 1 FROM jito_bundle_protocol v WHERE v.owner_id=b.owner_id AND v.bundle_id=b.id) OR EXISTS(SELECT 1 FROM jito_sign_attempts a WHERE a.owner_id=b.owner_id AND a.bundle_id=b.id AND NOT EXISTS(SELECT 1 FROM jito_sign_receipts r WHERE r.owner_id=a.owner_id AND r.bundle_id=a.bundle_id AND r.packet=a.packet)))) BEGIN SELECT RAISE(ABORT,'Bundle execution reservation is retained'); END;
--> statement-breakpoint
CREATE TRIGGER jito_v2_swap_reservation_update BEFORE UPDATE ON solana_swap_reservations WHEN EXISTS(SELECT 1 FROM jito_bundle_packets p JOIN jito_bundles b ON b.owner_id=p.owner_id AND b.id=p.bundle_id JOIN imported_swap_signing_intents i ON i.owner_id=p.owner_id AND i.id=p.intent_id WHERE i.owner_id=OLD.owner_id AND i.id=OLD.intent_id AND i.wallet_address=OLD.wallet_address AND b.state IN ('reviewed','submitting','submitted') AND (NOT EXISTS(SELECT 1 FROM jito_bundle_protocol v WHERE v.owner_id=b.owner_id AND v.bundle_id=b.id) OR EXISTS(SELECT 1 FROM jito_sign_attempts a WHERE a.owner_id=b.owner_id AND a.bundle_id=b.id AND NOT EXISTS(SELECT 1 FROM jito_sign_receipts r WHERE r.owner_id=a.owner_id AND r.bundle_id=a.bundle_id AND r.packet=a.packet)))) BEGIN SELECT RAISE(ABORT,'Bundle signing reservation is retained'); END;
--> statement-breakpoint
CREATE TRIGGER jito_v2_execution_reservation_update BEFORE UPDATE ON solana_execution_reservations WHEN EXISTS(SELECT 1 FROM jito_bundle_packets p JOIN jito_bundles b ON b.owner_id=p.owner_id AND b.id=p.bundle_id JOIN imported_swap_signing_intents i ON i.owner_id=p.owner_id AND i.id=p.intent_id WHERE i.owner_id=OLD.owner_id AND i.id=OLD.intent_id AND i.wallet_address=OLD.wallet_address AND b.state IN ('reviewed','submitting','submitted') AND (NOT EXISTS(SELECT 1 FROM jito_bundle_protocol v WHERE v.owner_id=b.owner_id AND v.bundle_id=b.id) OR EXISTS(SELECT 1 FROM jito_sign_attempts a WHERE a.owner_id=b.owner_id AND a.bundle_id=b.id AND NOT EXISTS(SELECT 1 FROM jito_sign_receipts r WHERE r.owner_id=a.owner_id AND r.bundle_id=a.bundle_id AND r.packet=a.packet)))) BEGIN SELECT RAISE(ABORT,'Bundle execution reservation is retained'); END;
--> statement-breakpoint
CREATE TRIGGER jito_v2_intent_delete BEFORE DELETE ON imported_swap_signing_intents WHEN EXISTS(SELECT 1 FROM jito_bundle_packets p WHERE p.owner_id=OLD.owner_id AND p.intent_id=OLD.id) BEGIN SELECT RAISE(ABORT,'Bundle intent history is retained'); END;
--> statement-breakpoint
CREATE TRIGGER jito_v2_bundle_delete BEFORE DELETE ON jito_bundles BEGIN SELECT RAISE(ABORT,'Bundle history is retained'); END;
--> statement-breakpoint
CREATE TRIGGER jito_v2_packet_delete BEFORE DELETE ON jito_bundle_packets BEGIN SELECT RAISE(ABORT,'Bundle packet history is retained'); END;
