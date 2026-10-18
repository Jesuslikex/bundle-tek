CREATE TABLE `volume_bundle_recovery_packets` (
	`reservation_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`signature` text NOT NULL,
	`packet` text NOT NULL,
	`packet_sha256` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`reservation_id`) REFERENCES `volume_bundle_reservations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `volume_bundle_recovery_signature` ON `volume_bundle_recovery_packets` (`signature`);--> statement-breakpoint
CREATE TABLE `volume_bundle_settlements` (
	`reservation_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`signature` text NOT NULL,
	`document` text NOT NULL,
	`sha256` text NOT NULL,
	`tip_spent` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`reservation_id`) REFERENCES `volume_bundle_reservations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `volume_bundle_settlement_signature` ON `volume_bundle_settlements` (`signature`);
--> statement-breakpoint
CREATE TRIGGER volume_recovery_packet_guard BEFORE INSERT ON volume_bundle_recovery_packets BEGIN
 SELECT CASE WHEN length(NEW.signature) NOT BETWEEN 64 AND 88 OR length(NEW.packet)>1644 OR length(NEW.packet_sha256)<>64
 OR NOT EXISTS(SELECT 1 FROM volume_bundle_reservations r WHERE r.id=NEW.reservation_id AND r.owner_id=NEW.owner_id AND r.state='attempted' AND r.attempt_id=NEW.attempt_id)
 THEN RAISE(ABORT,'Owned attempted packet required') END;
END;
--> statement-breakpoint
CREATE TRIGGER volume_recovery_packet_immutable BEFORE UPDATE ON volume_bundle_recovery_packets BEGIN SELECT RAISE(ABORT,'Volume recovery packet immutable'); END;
--> statement-breakpoint
CREATE TRIGGER volume_recovery_packet_retained BEFORE DELETE ON volume_bundle_recovery_packets BEGIN SELECT RAISE(ABORT,'Volume recovery packet retained'); END;
--> statement-breakpoint
CREATE TRIGGER volume_settlement_guard BEFORE INSERT ON volume_bundle_settlements BEGIN
 SELECT CASE WHEN NOT json_valid(NEW.document) OR length(NEW.document)>300000 OR length(NEW.sha256)<>64 OR typeof(NEW.tip_spent)<>'integer'
 OR json_extract(NEW.document,'$.format') IS NOT 'volume-settlement-recovery-v1'
 OR json_extract(NEW.document,'$.sha256') IS NOT NEW.sha256
 OR json_extract(NEW.document,'$.reservationId') IS NOT NEW.reservation_id
 OR json_extract(NEW.document,'$.executionAllowed') IS NOT 0 OR json_extract(NEW.document,'$.signingAllowed') IS NOT 0
 OR json_extract(NEW.document,'$.historicalCodeAttested') IS NOT 0
 OR json_extract(NEW.document,'$.proof.pumpAccountingVerified') IS NOT 1
 OR json_extract(NEW.document,'$.proof.accountingVerified') IS NOT 1
 OR json_extract(NEW.document,'$.proof.executionAllowed') IS NOT 0 OR json_extract(NEW.document,'$.proof.signingAllowed') IS NOT 0
 OR json_extract(NEW.document,'$.proof.signature') IS NOT NEW.signature
 OR json_extract(NEW.document,'$.receipt.signature') IS NOT NEW.signature
 OR json_extract(NEW.document,'$.receipt.commitment') IS NOT 'finalized'
 OR NOT ((json_extract(NEW.document,'$.proof.outcome') IS 'succeeded' AND json_type(NEW.document,'$.receipt.result.meta.err') IS 'null')
 OR (json_extract(NEW.document,'$.proof.outcome') IS 'failed' AND json_extract(NEW.document,'$.proof.atomicRollbackVerified') IS 1 AND (json_type(NEW.document,'$.receipt.result.meta.err') IS 'text' OR json_type(NEW.document,'$.receipt.result.meta.err') IS 'object')))
 OR NOT EXISTS(SELECT 1 FROM volume_bundle_reservations r JOIN volume_bundle_recovery_packets b ON b.reservation_id=r.id AND b.owner_id=r.owner_id
 WHERE r.id=NEW.reservation_id AND r.owner_id=NEW.owner_id AND r.state='attempted' AND r.attempt_id=b.attempt_id
 AND b.signature=NEW.signature AND b.packet_sha256=json_extract(NEW.document,'$.proof.signedPacketSha256')
 AND b.packet=json_extract(NEW.document,'$.receipt.result.transaction[0]')
 AND r.attempt_id=json_extract(NEW.document,'$.attemptId') AND r.runtime_sha256=json_extract(NEW.document,'$.runtimeSha256')
 AND r.construction_sha256=json_extract(NEW.document,'$.proof.constructionSha256')
 AND json_extract(r.document,'$.route.sha256')=json_extract(NEW.document,'$.proof.routeSha256')
 AND NEW.tip_spent BETWEEN 0 AND r.tip_cap
 AND CAST(json_extract(NEW.document,'$.proof.tipLamports') AS INTEGER)=NEW.tip_spent
 AND ((json_extract(NEW.document,'$.proof.outcome')='succeeded' AND CAST(json_extract(r.document,'$.construction.input.tipLamports') AS INTEGER)=NEW.tip_spent)
 OR (json_extract(NEW.document,'$.proof.outcome')='failed' AND NEW.tip_spent=0)))
 THEN RAISE(ABORT,'Verified bound Volume settlement required') END;
END;
--> statement-breakpoint
CREATE TRIGGER volume_settlement_immutable BEFORE UPDATE ON volume_bundle_settlements BEGIN SELECT RAISE(ABORT,'Volume settlement immutable'); END;
--> statement-breakpoint
CREATE TRIGGER volume_settlement_retained BEFORE DELETE ON volume_bundle_settlements BEGIN SELECT RAISE(ABORT,'Volume settlement retained'); END;
--> statement-breakpoint
DROP TRIGGER volume_bundle_reservation_transition;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_reservation_transition BEFORE UPDATE ON volume_bundle_reservations BEGIN
 SELECT CASE WHEN NEW.state='attempted' AND NOT EXISTS(SELECT 1 FROM volume_bundle_sessions s JOIN imported_token_projects p ON p.owner_id=s.owner_id AND p.id=s.project_id
 JOIN workspace_wallets w ON w.owner_id=s.owner_id AND w.chain='Solana' AND w.address=NEW.wallet JOIN wallet_ownership_proofs o ON o.owner_id=w.owner_id AND o.chain=w.chain AND o.address=w.address
 WHERE s.id=NEW.session_id AND s.owner_id=NEW.owner_id AND s.revision=NEW.session_revision AND p.revision=s.project_revision AND p.archived=0 AND json_extract(p.document,'$.token.address')=s.mint AND w.revision=NEW.wallet_revision AND w.archived=0)
 THEN RAISE(ABORT,'Volume attempt parent changed') END;
 SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.session_id IS NOT OLD.session_id OR NEW.session_revision IS NOT OLD.session_revision
 OR NEW.round IS NOT OLD.round OR NEW.wallet IS NOT OLD.wallet OR NEW.wallet_revision IS NOT OLD.wallet_revision OR NEW.construction_sha256 IS NOT OLD.construction_sha256
 OR NEW.runtime_sha256 IS NOT OLD.runtime_sha256 OR NEW.document IS NOT OLD.document OR NEW.tip_cap IS NOT OLD.tip_cap OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at
 OR NOT ((OLD.state='attempted' AND NEW.state='settled' AND NEW.attempt_id IS OLD.attempt_id AND EXISTS(SELECT 1 FROM volume_bundle_settlements s WHERE s.reservation_id=OLD.id AND s.owner_id=OLD.owner_id)) OR (OLD.state='held' AND NEW.state='cancelled' AND NEW.attempt_id IS NULL) OR (OLD.state='held' AND NEW.state='attempted' AND NEW.attempt_id IS NOT NULL AND length(NEW.attempt_id)=36 AND NEW.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
 THEN RAISE(ABORT,'Immutable Volume reservation or unresolved attempt') END;
END;
--> statement-breakpoint
CREATE TRIGGER volume_settlement_apply AFTER INSERT ON volume_bundle_settlements BEGIN
 UPDATE volume_bundle_reservations SET state='settled',updated_at=NEW.created_at WHERE id=NEW.reservation_id AND owner_id=NEW.owner_id AND state='attempted';
END;
--> statement-breakpoint
DROP INDEX volume_bundle_active_round;
--> statement-breakpoint
CREATE UNIQUE INDEX volume_bundle_active_round ON volume_bundle_reservations(session_id,round) WHERE state IN ('held','attempted','settled');
--> statement-breakpoint
CREATE TRIGGER volume_settled_tip_budget BEFORE INSERT ON volume_bundle_reservations BEGIN
 SELECT CASE WHEN NEW.tip_cap+COALESCE((SELECT SUM(tip_cap) FROM volume_bundle_reservations WHERE owner_id=NEW.owner_id AND session_id=NEW.session_id AND state IN ('held','attempted')),0)
 +COALESCE((SELECT SUM(s.tip_spent) FROM volume_bundle_settlements s JOIN volume_bundle_reservations r ON r.id=s.reservation_id WHERE r.owner_id=NEW.owner_id AND r.session_id=NEW.session_id),0)
 >(SELECT tip_budget FROM volume_bundle_sessions WHERE id=NEW.session_id AND owner_id=NEW.owner_id)
 THEN RAISE(ABORT,'Volume session tip budget exhausted') END;
END;
