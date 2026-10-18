CREATE TABLE `volume_bundle_reservation_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reservation_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`reservation_id`) REFERENCES `volume_bundle_reservations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `volume_bundle_reservation_event_state` ON `volume_bundle_reservation_events` (`reservation_id`,`state`);--> statement-breakpoint
CREATE TABLE `volume_bundle_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`session_id` text NOT NULL,
	`session_revision` integer NOT NULL,
	`round` integer NOT NULL,
	`wallet` text NOT NULL,
	`wallet_revision` integer NOT NULL,
	`construction_sha256` text NOT NULL,
	`runtime_sha256` text NOT NULL,
	`document` text NOT NULL,
	`tip_cap` integer NOT NULL,
	`state` text NOT NULL,
	`attempt_id` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `volume_bundle_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `volume_bundle_reservations_owner` ON `volume_bundle_reservations` (`owner_id`,`session_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `volume_bundle_active_round` ON `volume_bundle_reservations` (`session_id`,`round`) WHERE "volume_bundle_reservations"."state" IN ('held','attempted');--> statement-breakpoint
CREATE UNIQUE INDEX `volume_bundle_wallet_lock` ON `volume_bundle_reservations` (`owner_id`,`wallet`) WHERE "volume_bundle_reservations"."state" IN ('held','attempted');--> statement-breakpoint
CREATE UNIQUE INDEX `volume_bundle_attempt_id` ON `volume_bundle_reservations` (`owner_id`,`attempt_id`);--> statement-breakpoint
CREATE TABLE `volume_bundle_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`project_id` text NOT NULL,
	`project_revision` integer NOT NULL,
	`revision` integer NOT NULL,
	`mint` text NOT NULL,
	`plan` text NOT NULL,
	`plan_sha256` text NOT NULL,
	`wallets` text NOT NULL,
	`tip_budget` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `volume_bundle_sessions_owner` ON `volume_bundle_sessions` (`owner_id`,`project_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER volume_bundle_session_guard BEFORE INSERT ON volume_bundle_sessions BEGIN
 SELECT CASE WHEN NOT json_valid(NEW.plan) OR length(NEW.plan)>262144 OR NOT json_valid(NEW.wallets)
 OR json_extract(NEW.plan,'$.format') IS NOT 'volume-bundle-plan-v1' OR json_extract(NEW.plan,'$.mode') IS NOT 'same-block'
 OR json_extract(NEW.plan,'$.executionAllowed') IS NOT 0 OR json_extract(NEW.plan,'$.signingAllowed') IS NOT 0
 OR NEW.revision<>1 OR NEW.tip_budget NOT BETWEEN 1000 AND 2500000249 OR CAST(json_extract(NEW.plan,'$.terms.tipBudgetLamports') AS INTEGER) IS NOT NEW.tip_budget
 OR json_type(NEW.plan,'$.terms.wallets') IS NOT 'array' OR json_type(NEW.plan,'$.rounds') IS NOT 'array'
 OR json_array_length(NEW.wallets) NOT BETWEEN 1 AND 25 OR json_array_length(NEW.wallets) IS NOT json_array_length(NEW.plan,'$.terms.wallets')
 OR json_array_length(NEW.plan,'$.rounds') NOT BETWEEN 1 AND 250
 OR (SELECT count(DISTINCT json_extract(value,'$.address')) FROM json_each(NEW.wallets))<>json_array_length(NEW.wallets)
 THEN RAISE(ABORT,'Invalid Volume bundle session') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM imported_token_projects p WHERE p.owner_id=NEW.owner_id AND p.id=NEW.project_id
 AND p.revision=NEW.project_revision AND p.archived=0 AND p.chain='Solana' AND json_extract(p.document,'$.token.address')=NEW.mint)
 OR EXISTS(SELECT 1 FROM json_each(NEW.wallets) ref WHERE json_extract(ref.value,'$.address') IS NOT json_extract(NEW.plan,'$.terms.wallets['||ref.key||']') OR NOT EXISTS(
 SELECT 1 FROM workspace_wallets w JOIN wallet_ownership_proofs o ON o.owner_id=w.owner_id AND o.chain=w.chain AND o.address=w.address
 WHERE w.owner_id=NEW.owner_id AND w.chain='Solana' AND w.archived=0 AND w.address=json_extract(ref.value,'$.address') AND w.revision=json_extract(ref.value,'$.revision')))
 THEN RAISE(ABORT,'Volume project or proven wallet changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_session_immutable BEFORE UPDATE ON volume_bundle_sessions BEGIN SELECT RAISE(ABORT,'Volume bundle session is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_session_retained BEFORE DELETE ON volume_bundle_sessions BEGIN SELECT RAISE(ABORT,'Volume bundle session is retained'); END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_reserve_guard BEFORE INSERT ON volume_bundle_reservations BEGIN
 SELECT CASE WHEN NEW.state<>'held' OR NEW.attempt_id IS NOT NULL OR NOT json_valid(NEW.document) OR length(NEW.document)>524288
 OR json_extract(NEW.document,'$.format') IS NOT 'volume-validated-runtime-v1' OR json_extract(NEW.document,'$.codePolicyVerified') IS NOT 1
 OR json_extract(NEW.document,'$.executionAllowed') IS NOT 0 OR json_extract(NEW.document,'$.signingAllowed') IS NOT 0
 OR json_extract(NEW.document,'$.sha256') IS NOT NEW.runtime_sha256 OR json_extract(NEW.document,'$.construction.sha256') IS NOT NEW.construction_sha256
 OR json_extract(NEW.document,'$.simulation.constructionSha256') IS NOT NEW.construction_sha256
 OR json_extract(NEW.document,'$.simulation.simulationChecksPassed') IS NOT 1
 OR julianday(NEW.expires_at) IS NULL OR julianday(json_extract(NEW.document,'$.observedAt')) IS NULL
 OR julianday(NEW.expires_at)<=julianday('now') OR julianday(NEW.expires_at)>julianday('now')+30.0/86400
 OR julianday(json_extract(NEW.document,'$.observedAt')) NOT BETWEEN julianday('now')-30.0/86400 AND julianday('now')+2.0/86400
 THEN RAISE(ABORT,'Fresh disabled Volume runtime required') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM volume_bundle_sessions s JOIN imported_token_projects p ON p.owner_id=s.owner_id AND p.id=s.project_id
 JOIN workspace_wallets w ON w.owner_id=s.owner_id AND w.chain='Solana' AND w.address=NEW.wallet
 JOIN wallet_ownership_proofs o ON o.owner_id=w.owner_id AND o.chain=w.chain AND o.address=w.address
 WHERE s.id=NEW.session_id AND s.owner_id=NEW.owner_id AND s.revision=NEW.session_revision
 AND p.revision=s.project_revision AND p.archived=0 AND p.chain='Solana' AND json_extract(p.document,'$.token.address')=s.mint
 AND w.revision=NEW.wallet_revision AND w.archived=0
 AND EXISTS(SELECT 1 FROM json_each(s.wallets) ref WHERE json_extract(ref.value,'$.address')=NEW.wallet AND json_extract(ref.value,'$.revision')=NEW.wallet_revision)
 AND json_extract(NEW.document,'$.construction.input.projectId')=s.project_id AND json_extract(NEW.document,'$.construction.input.projectRevision')=s.project_revision
 AND json_extract(NEW.document,'$.construction.input.sessionId')=s.id AND json_extract(NEW.document,'$.construction.input.sessionRevision')=s.revision
 AND json_extract(NEW.document,'$.construction.input.mint')=s.mint AND json_extract(NEW.document,'$.construction.input.plan')=s.plan
 AND json_extract(NEW.document,'$.construction.input.round')=NEW.round AND json_extract(NEW.document,'$.construction.wallet')=NEW.wallet
 AND json_extract(s.plan,'$.rounds['||NEW.round||'].wallet')=NEW.wallet
 AND CAST(json_extract(s.plan,'$.rounds['||NEW.round||'].tipCapLamports') AS INTEGER)=NEW.tip_cap
 AND NEW.tip_cap BETWEEN 1000 AND 10000000
 AND NEW.tip_cap+COALESCE((SELECT SUM(r.tip_cap) FROM volume_bundle_reservations r WHERE r.owner_id=NEW.owner_id AND r.session_id=s.id AND r.state IN ('held','attempted')),0)<=s.tip_budget)
 THEN RAISE(ABORT,'Volume parent, wallet, round or tip budget changed') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM solana_execution_reservations r WHERE r.owner_id=NEW.owner_id AND r.wallet_address=NEW.wallet)
 OR EXISTS(SELECT 1 FROM volume_bot_sessions s,json_each(s.plan,'$.wallets') w WHERE s.owner_id=NEW.owner_id AND w.value=NEW.wallet AND (s.state='active' OR EXISTS(SELECT 1 FROM volume_bot_batches b JOIN volume_bot_trades t ON t.batch_id=b.id WHERE b.session_id=s.id AND t.state IN ('signed','submitting','submitted'))))
 OR EXISTS(SELECT 1 FROM pump_organic_sequences s,json_each(s.plan,'$.rows') w WHERE s.owner_id=NEW.owner_id AND json_extract(w.value,'$.address')=NEW.wallet AND (s.state='active' OR EXISTS(SELECT 1 FROM pump_organic_batches b JOIN pump_organic_buys t ON t.batch_id=b.id WHERE b.sequence_id=s.id AND t.state IN ('signed','submitting','submitted'))))
 OR EXISTS(SELECT 1 FROM pump_launch_reviews r WHERE r.owner_id=NEW.owner_id AND r.state NOT IN ('cancelled','failed','finalized') AND (r.payer=NEW.wallet OR EXISTS(SELECT 1 FROM json_each(r.review,'$.input.holders') w WHERE json_extract(w.value,'$.address')=NEW.wallet AND json_extract(w.value,'$.kind')!='none')))
 OR EXISTS(SELECT 1 FROM pair_order_executions r WHERE r.owner_id=NEW.owner_id AND r.wallet=NEW.wallet AND r.state IN ('reserved','signed','submitting','submitted'))
 OR EXISTS(SELECT 1 FROM token_supply_actions r WHERE r.owner_id=NEW.owner_id AND r.wallet_address=NEW.wallet AND r.state IN ('awaiting_signature','signing','signed','submitted'))
 OR EXISTS(SELECT 1 FROM counter_proposal_reservations r WHERE r.owner_id=NEW.owner_id AND r.wallet_address=NEW.wallet AND (r.approval_id IS NOT NULL OR r.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
 THEN RAISE(ABORT,'Volume wallet already reserved by another flow') END;
END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_reservation_transition BEFORE UPDATE ON volume_bundle_reservations BEGIN
 SELECT CASE WHEN NEW.state='attempted' AND NOT EXISTS(SELECT 1 FROM volume_bundle_sessions s JOIN imported_token_projects p ON p.owner_id=s.owner_id AND p.id=s.project_id
 JOIN workspace_wallets w ON w.owner_id=s.owner_id AND w.chain='Solana' AND w.address=NEW.wallet JOIN wallet_ownership_proofs o ON o.owner_id=w.owner_id AND o.chain=w.chain AND o.address=w.address
 WHERE s.id=NEW.session_id AND s.owner_id=NEW.owner_id AND s.revision=NEW.session_revision AND p.revision=s.project_revision AND p.archived=0 AND json_extract(p.document,'$.token.address')=s.mint AND w.revision=NEW.wallet_revision AND w.archived=0)
 THEN RAISE(ABORT,'Volume attempt parent changed') END;
 SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.session_id IS NOT OLD.session_id OR NEW.session_revision IS NOT OLD.session_revision
 OR NEW.round IS NOT OLD.round OR NEW.wallet IS NOT OLD.wallet OR NEW.wallet_revision IS NOT OLD.wallet_revision OR NEW.construction_sha256 IS NOT OLD.construction_sha256
 OR NEW.runtime_sha256 IS NOT OLD.runtime_sha256 OR NEW.document IS NOT OLD.document OR NEW.tip_cap IS NOT OLD.tip_cap OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at
 OR NOT ((OLD.state='held' AND NEW.state='cancelled' AND NEW.attempt_id IS NULL) OR (OLD.state='held' AND NEW.state='attempted' AND NEW.attempt_id IS NOT NULL AND length(NEW.attempt_id)=36 AND NEW.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
 THEN RAISE(ABORT,'Immutable Volume reservation or unresolved attempt') END;
END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_reservation_retained BEFORE DELETE ON volume_bundle_reservations BEGIN SELECT RAISE(ABORT,'Volume reservation history retained'); END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_reservation_event_insert AFTER INSERT ON volume_bundle_reservations BEGIN
 INSERT INTO volume_bundle_reservation_events(reservation_id,owner_id,state,created_at) VALUES(NEW.id,NEW.owner_id,NEW.state,NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_reservation_event_update AFTER UPDATE ON volume_bundle_reservations BEGIN
 INSERT INTO volume_bundle_reservation_events(reservation_id,owner_id,state,created_at) VALUES(NEW.id,NEW.owner_id,NEW.state,NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_event_guard BEFORE INSERT ON volume_bundle_reservation_events BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM volume_bundle_reservations r WHERE r.id=NEW.reservation_id AND r.owner_id=NEW.owner_id AND r.state=NEW.state AND r.updated_at=NEW.created_at) THEN RAISE(ABORT,'Volume event differs from reservation') END;
END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_event_immutable BEFORE UPDATE ON volume_bundle_reservation_events BEGIN SELECT RAISE(ABORT,'Volume event immutable'); END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_event_retained BEFORE DELETE ON volume_bundle_reservation_events BEGIN SELECT RAISE(ABORT,'Volume event retained'); END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_blocks_shared_insert BEFORE INSERT ON solana_execution_reservations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM volume_bundle_reservations r WHERE r.owner_id=NEW.owner_id AND r.state IN ('held','attempted') AND (r.wallet=NEW.wallet_address)) THEN RAISE(ABORT,'Wallet reserved by same-block Volume') END;
END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_blocks_shared_update BEFORE UPDATE ON solana_execution_reservations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM volume_bundle_reservations r WHERE r.owner_id=NEW.owner_id AND r.state IN ('held','attempted') AND (r.wallet=NEW.wallet_address)) THEN RAISE(ABORT,'Wallet reserved by same-block Volume') END;
END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_blocks_scheduled_insert BEFORE INSERT ON volume_bot_sessions BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM volume_bundle_reservations r WHERE r.owner_id=NEW.owner_id AND r.state IN ('held','attempted') AND (NEW.state='active' AND r.wallet IN (SELECT value FROM json_each(NEW.plan,'$.wallets')))) THEN RAISE(ABORT,'Wallet reserved by same-block Volume') END;
END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_blocks_scheduled_update BEFORE UPDATE ON volume_bot_sessions BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM volume_bundle_reservations r WHERE r.owner_id=NEW.owner_id AND r.state IN ('held','attempted') AND (NEW.state='active' AND r.wallet IN (SELECT value FROM json_each(NEW.plan,'$.wallets')))) THEN RAISE(ABORT,'Wallet reserved by same-block Volume') END;
END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_blocks_organic_insert BEFORE INSERT ON pump_organic_sequences BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM volume_bundle_reservations r WHERE r.owner_id=NEW.owner_id AND r.state IN ('held','attempted') AND (NEW.state='active' AND r.wallet IN (SELECT json_extract(value,'$.address') FROM json_each(NEW.plan,'$.rows')))) THEN RAISE(ABORT,'Wallet reserved by same-block Volume') END;
END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_blocks_organic_update BEFORE UPDATE ON pump_organic_sequences BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM volume_bundle_reservations r WHERE r.owner_id=NEW.owner_id AND r.state IN ('held','attempted') AND (NEW.state='active' AND r.wallet IN (SELECT json_extract(value,'$.address') FROM json_each(NEW.plan,'$.rows')))) THEN RAISE(ABORT,'Wallet reserved by same-block Volume') END;
END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_blocks_launch_insert BEFORE INSERT ON pump_launch_reviews BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM volume_bundle_reservations r WHERE r.owner_id=NEW.owner_id AND r.state IN ('held','attempted') AND (NEW.state NOT IN ('cancelled','failed','finalized') AND (r.wallet=NEW.payer OR r.wallet IN (SELECT json_extract(value,'$.address') FROM json_each(NEW.review,'$.input.holders') WHERE json_extract(value,'$.kind')!='none')))) THEN RAISE(ABORT,'Wallet reserved by same-block Volume') END;
END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_blocks_launch_update BEFORE UPDATE ON pump_launch_reviews BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM volume_bundle_reservations r WHERE r.owner_id=NEW.owner_id AND r.state IN ('held','attempted') AND (NEW.state NOT IN ('cancelled','failed','finalized') AND (r.wallet=NEW.payer OR r.wallet IN (SELECT json_extract(value,'$.address') FROM json_each(NEW.review,'$.input.holders') WHERE json_extract(value,'$.kind')!='none')))) THEN RAISE(ABORT,'Wallet reserved by same-block Volume') END;
END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_blocks_pair_insert BEFORE INSERT ON pair_order_executions BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM volume_bundle_reservations r WHERE r.owner_id=NEW.owner_id AND r.state IN ('held','attempted') AND (NEW.state IN ('reserved','signed','submitting','submitted') AND r.wallet=NEW.wallet)) THEN RAISE(ABORT,'Wallet reserved by same-block Volume') END;
END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_blocks_pair_update BEFORE UPDATE ON pair_order_executions BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM volume_bundle_reservations r WHERE r.owner_id=NEW.owner_id AND r.state IN ('held','attempted') AND (NEW.state IN ('reserved','signed','submitting','submitted') AND r.wallet=NEW.wallet)) THEN RAISE(ABORT,'Wallet reserved by same-block Volume') END;
END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_blocks_supply_insert BEFORE INSERT ON token_supply_actions BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM volume_bundle_reservations r WHERE r.owner_id=NEW.owner_id AND r.state IN ('held','attempted') AND (NEW.state IN ('awaiting_signature','signing','signed','submitting','submitted') AND r.wallet=NEW.wallet_address)) THEN RAISE(ABORT,'Wallet reserved by same-block Volume') END;
END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_blocks_supply_update BEFORE UPDATE ON token_supply_actions BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM volume_bundle_reservations r WHERE r.owner_id=NEW.owner_id AND r.state IN ('held','attempted') AND (NEW.state IN ('awaiting_signature','signing','signed','submitting','submitted') AND r.wallet=NEW.wallet_address)) THEN RAISE(ABORT,'Wallet reserved by same-block Volume') END;
END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_blocks_counter_insert BEFORE INSERT ON counter_proposal_reservations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM volume_bundle_reservations r WHERE r.owner_id=NEW.owner_id AND r.state IN ('held','attempted') AND ((NEW.approval_id IS NOT NULL OR NEW.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND r.wallet=NEW.wallet_address)) THEN RAISE(ABORT,'Wallet reserved by same-block Volume') END;
END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_blocks_counter_update BEFORE UPDATE ON counter_proposal_reservations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM volume_bundle_reservations r WHERE r.owner_id=NEW.owner_id AND r.state IN ('held','attempted') AND ((NEW.approval_id IS NOT NULL OR NEW.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND r.wallet=NEW.wallet_address)) THEN RAISE(ABORT,'Wallet reserved by same-block Volume') END;
END;
