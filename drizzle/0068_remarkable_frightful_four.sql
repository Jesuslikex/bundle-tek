CREATE TABLE `jito_bundle_packets` (
	`owner_id` text NOT NULL,
	`bundle_id` text NOT NULL,
	`packet` integer NOT NULL,
	`intent_id` text,
	`transaction` text,
	`signature` text,
	PRIMARY KEY(`owner_id`, `bundle_id`, `packet`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jito_bundle_intent` ON `jito_bundle_packets` (`owner_id`,`intent_id`);--> statement-breakpoint
CREATE TABLE `jito_bundles` (
	`owner_id` text NOT NULL,
	`id` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`document` text NOT NULL,
	`state` text NOT NULL,
	`bundle_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `jito_bundles_project` ON `jito_bundles` (`owner_id`,`project_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER jito_bundle_insert BEFORE INSERT ON jito_bundles BEGIN
 SELECT CASE WHEN NEW.state<>'reviewed' OR NEW.bundle_id IS NOT NULL OR NOT json_valid(NEW.document) OR length(NEW.document)>45000 OR json_extract(NEW.document,'$.id')<>NEW.id OR json_extract(NEW.document,'$.projectId')<>NEW.project_id OR json_extract(NEW.document,'$.sessionId')<>NEW.session_id OR json_array_length(NEW.document,'$.swaps') NOT BETWEEN 1 AND 4 THEN RAISE(ABORT,'Invalid bundle manifest') END;
END;
--> statement-breakpoint
CREATE TRIGGER jito_packet_insert BEFORE INSERT ON jito_bundle_packets BEGIN
 SELECT CASE WHEN NEW.`transaction` IS NOT NULL OR NEW.signature IS NOT NULL OR NOT EXISTS(SELECT 1 FROM jito_bundles b WHERE b.owner_id=NEW.owner_id AND b.id=NEW.bundle_id AND b.state='reviewed' AND NEW.packet BETWEEN 0 AND json_array_length(b.document,'$.swaps') AND ((NEW.packet=json_array_length(b.document,'$.swaps') AND NEW.intent_id IS NULL) OR (NEW.packet<json_array_length(b.document,'$.swaps') AND EXISTS(SELECT 1 FROM imported_swap_signing_intents i JOIN imported_swap_preparations p ON p.owner_id=i.owner_id AND p.id=i.preparation_id JOIN imported_token_projects t ON t.owner_id=p.owner_id AND t.id=p.project_id JOIN workspace_wallets w ON w.owner_id=p.owner_id AND w.address=i.wallet_address AND w.chain='Solana' JOIN imported_trade_sessions s ON s.owner_id=i.owner_id AND s.id=b.session_id JOIN imported_trade_session_controls c ON c.owner_id=s.owner_id AND c.session_id=s.id WHERE i.owner_id=NEW.owner_id AND i.id=NEW.intent_id AND i.state='awaiting_signature' AND i.signature IS NULL AND i.document=json_extract(b.document,'$.swaps['||NEW.packet||']') AND p.project_id=b.project_id AND t.revision=p.project_revision AND t.archived=0 AND w.revision=p.wallet_revision AND w.archived=0 AND s.revision=json_extract(b.document,'$.sessionRevision') AND s.state='active' AND c.state='ready' AND julianday(json_extract(b.document,'$.expiresAt'))>julianday('now'))))) THEN RAISE(ABORT,'Bundle approval changed or already signed') END;
END;
--> statement-breakpoint
CREATE TRIGGER jito_bundle_immutable BEFORE UPDATE OF owner_id,id,project_id,session_id,document,created_at ON jito_bundles BEGIN SELECT RAISE(ABORT,'Bundle terms are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER jito_packet_identity BEFORE UPDATE OF owner_id,bundle_id,packet,intent_id ON jito_bundle_packets BEGIN SELECT RAISE(ABORT,'Bundle order is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER jito_packet_signature BEFORE UPDATE OF signature,`transaction` ON jito_bundle_packets BEGIN
 SELECT CASE WHEN OLD.signature IS NOT NULL OR OLD.`transaction` IS NOT NULL OR NEW.signature IS NULL OR NEW.`transaction` IS NULL OR length(NEW.`transaction`)>1644 OR NOT EXISTS(SELECT 1 FROM jito_bundles WHERE owner_id=NEW.owner_id AND id=NEW.bundle_id AND state='reviewed') OR (NEW.intent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM imported_swap_signing_intents WHERE owner_id=NEW.owner_id AND id=NEW.intent_id AND state='signed' AND signature=NEW.signature)) THEN RAISE(ABORT,'Bundle signature cannot change') END;
END;
--> statement-breakpoint
CREATE TRIGGER jito_member_cancel BEFORE UPDATE OF state ON imported_swap_signing_intents WHEN OLD.state<>NEW.state AND NEW.state='cancelled' AND EXISTS(SELECT 1 FROM jito_bundle_packets WHERE owner_id=OLD.owner_id AND intent_id=OLD.id) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM jito_bundle_packets p JOIN jito_bundles b ON b.owner_id=p.owner_id AND b.id=p.bundle_id WHERE p.owner_id=OLD.owner_id AND p.intent_id=OLD.id AND b.state IN ('cancelled','expired')) THEN RAISE(ABORT,'Cancel or recover the complete bundle') END;
END;
--> statement-breakpoint
CREATE TRIGGER jito_member_submit BEFORE UPDATE OF state ON imported_swap_signing_intents WHEN OLD.state<>NEW.state AND NEW.state='submitted' AND EXISTS(SELECT 1 FROM jito_bundle_packets WHERE owner_id=OLD.owner_id AND intent_id=OLD.id) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM jito_bundle_packets p JOIN jito_bundles b ON b.owner_id=p.owner_id AND b.id=p.bundle_id WHERE p.owner_id=OLD.owner_id AND p.intent_id=OLD.id AND b.state='submitting') THEN RAISE(ABORT,'Submit the complete bundle') END;
END;
--> statement-breakpoint
CREATE TRIGGER jito_bundle_transition BEFORE UPDATE OF state ON jito_bundles WHEN NEW.state<>OLD.state BEGIN
 SELECT CASE WHEN NOT ((OLD.state='reviewed' AND NEW.state IN ('submitting','cancelled','expired')) OR (OLD.state='submitting' AND NEW.state IN ('submitted','finalized','expired')) OR (OLD.state='submitted' AND NEW.state IN ('finalized','expired'))) THEN RAISE(ABORT,'Invalid bundle transition') END;
 SELECT CASE WHEN NEW.state='cancelled' AND EXISTS(SELECT 1 FROM jito_bundle_packets WHERE owner_id=OLD.owner_id AND bundle_id=OLD.id AND signature IS NOT NULL) THEN RAISE(ABORT,'Signed bundles require recovery') END;
 SELECT CASE WHEN NEW.state='submitting' AND (
  julianday(json_extract(OLD.document,'$.expiresAt'))<=julianday('now') OR
  (SELECT count(*) FROM jito_bundle_packets WHERE owner_id=OLD.owner_id AND bundle_id=OLD.id AND signature IS NOT NULL AND `transaction` IS NOT NULL)<>json_array_length(OLD.document,'$.swaps')+1 OR
  NOT EXISTS(SELECT 1 FROM imported_trade_sessions s JOIN imported_trade_session_controls c ON c.owner_id=s.owner_id AND c.session_id=s.id WHERE s.owner_id=OLD.owner_id AND s.id=OLD.session_id AND s.project_id=OLD.project_id AND s.state='active' AND s.revision=json_extract(OLD.document,'$.sessionRevision') AND c.state='ready') OR
  EXISTS(SELECT 1 FROM jito_bundle_packets bp LEFT JOIN imported_swap_signing_intents i ON i.owner_id=bp.owner_id AND i.id=bp.intent_id LEFT JOIN imported_swap_preparations p ON p.owner_id=i.owner_id AND p.id=i.preparation_id LEFT JOIN imported_token_projects t ON t.owner_id=p.owner_id AND t.id=p.project_id LEFT JOIN workspace_wallets w ON w.owner_id=p.owner_id AND w.address=i.wallet_address AND w.chain='Solana' LEFT JOIN solana_swap_reservations r ON r.owner_id=i.owner_id AND r.wallet_address=i.wallet_address WHERE bp.owner_id=OLD.owner_id AND bp.bundle_id=OLD.id AND bp.intent_id IS NOT NULL AND (i.id IS NULL OR i.state<>'signed' OR i.signature<>bp.signature OR t.id IS NULL OR t.archived<>0 OR t.revision<>p.project_revision OR w.address IS NULL OR w.archived<>0 OR w.revision<>p.wallet_revision OR r.intent_id<>i.id OR r.intent_id IS NULL OR r.scope<>'imported' OR r.state<>'signed' OR julianday(json_extract(i.document,'$.expiresAt'))<=julianday('now')))
 ) THEN RAISE(ABORT,'Bundle is incomplete or context changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER jito_bundle_claim AFTER UPDATE OF state ON jito_bundles WHEN NEW.state<>OLD.state AND NEW.state='submitting' BEGIN
 UPDATE imported_swap_signing_intents SET state='submitted',updated_at=NEW.updated_at WHERE owner_id=NEW.owner_id AND id IN (SELECT intent_id FROM jito_bundle_packets WHERE owner_id=NEW.owner_id AND bundle_id=NEW.id AND intent_id IS NOT NULL);
END;
--> statement-breakpoint
CREATE TRIGGER jito_bundle_release AFTER UPDATE OF state ON jito_bundles WHEN NEW.state<>OLD.state AND NEW.state IN ('cancelled','expired') BEGIN
 UPDATE imported_swap_signing_intents SET state='cancelled',updated_at=NEW.updated_at WHERE owner_id=NEW.owner_id AND state IN ('awaiting_signature','signed','submitted') AND id IN (SELECT intent_id FROM jito_bundle_packets WHERE owner_id=NEW.owner_id AND bundle_id=NEW.id AND intent_id IS NOT NULL);
END;
--> statement-breakpoint
CREATE TRIGGER jito_preparation_immutable BEFORE UPDATE ON imported_swap_preparations WHEN EXISTS(SELECT 1 FROM jito_bundle_packets bp JOIN imported_swap_signing_intents i ON i.owner_id=bp.owner_id AND i.id=bp.intent_id WHERE bp.owner_id=OLD.owner_id AND i.preparation_id=OLD.id) BEGIN SELECT RAISE(ABORT,'Bundled preparation is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER jito_preparation_retained BEFORE DELETE ON imported_swap_preparations WHEN EXISTS(SELECT 1 FROM jito_bundle_packets bp JOIN imported_swap_signing_intents i ON i.owner_id=bp.owner_id AND i.id=bp.intent_id WHERE bp.owner_id=OLD.owner_id AND i.preparation_id=OLD.id) BEGIN SELECT RAISE(ABORT,'Bundled preparation history is retained'); END;
