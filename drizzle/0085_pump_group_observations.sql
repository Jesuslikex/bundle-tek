CREATE TABLE `pump_group_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`review_id` text NOT NULL,
	`context_sha256` text NOT NULL,
	`manifest_sha256` text NOT NULL,
	`signed_group_sha256` text,
	`source_state` text NOT NULL,
	`observed_state` text NOT NULL,
	`sha256` text NOT NULL,
	`observation` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `pump_launch_reviews`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pump_group_observation_owner` ON `pump_group_observations` (`owner_id`,`review_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER pump_group_observation_insert BEFORE INSERT ON pump_group_observations BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pump_launch_reviews r JOIN pump_group_approvals a ON a.review_id=r.id AND a.owner_id=r.owner_id
 WHERE r.id=NEW.review_id AND r.owner_id=NEW.owner_id AND json_extract(r.review,'$.format')='pump-launch-group-review-v1'
 AND r.state=NEW.source_state AND r.state IN ('approved','signed') AND r.receipt IS NULL
 AND json_extract(r.review,'$.contextSha256')=NEW.context_sha256 AND json_extract(r.review,'$.manifestSha256')=NEW.manifest_sha256
 AND a.context_sha256=NEW.context_sha256 AND a.manifest_sha256=NEW.manifest_sha256 AND a.simulation_sha256=json_extract(r.review,'$.simulationSha256')
 AND ((r.state='approved' AND r.signed IS NULL AND r.signature IS NULL AND NEW.signed_group_sha256 IS NULL)
 OR (r.state='signed' AND NEW.signed_group_sha256=json_extract(r.signed,'$.signedGroupSha256') AND EXISTS(
 SELECT 1 FROM pump_group_signatures s WHERE s.review_id=r.id AND s.owner_id=r.owner_id AND s.signed=r.signed AND s.signature=r.signature
 AND s.context_sha256=NEW.context_sha256 AND s.manifest_sha256=NEW.manifest_sha256 AND s.signed_group_sha256=NEW.signed_group_sha256))))
 THEN RAISE(ABORT,'Group observation approval or signing state changed') END;
 SELECT CASE WHEN json_extract(NEW.observation,'$.state') IS NOT NEW.observed_state OR NEW.observed_state NOT IN ('complete','failed','partial','pending','expired-unobserved','unknown')
 OR json_extract(NEW.observation,'$.receipt.format') IS NOT 'pump-launch-group-recovery-observation-v1'
 OR json_extract(NEW.observation,'$.receipt.reviewId') IS NOT NEW.review_id OR json_extract(NEW.observation,'$.receipt.contextSha256') IS NOT NEW.context_sha256
 OR json_extract(NEW.observation,'$.receipt.manifestSha256') IS NOT NEW.manifest_sha256 OR json_extract(NEW.observation,'$.receipt.signedGroupSha256') IS NOT NEW.signed_group_sha256
 OR json_extract(NEW.observation,'$.receipt.network') IS NOT 'mainnet' OR json_extract(NEW.observation,'$.receipt.commitment') IS NOT 'finalized'
 OR json_extract(NEW.observation,'$.receipt.mint') IS NOT (SELECT mint FROM pump_launch_reviews WHERE id=NEW.review_id AND owner_id=NEW.owner_id)
 OR json_extract(NEW.observation,'$.receipt.observedAt') IS NOT NEW.created_at OR julianday(NEW.created_at) IS NULL
 OR abs(julianday('now')-julianday(NEW.created_at))>5.0/86400
 OR json_extract(NEW.observation,'$.receipt.signatureKnown') IS NOT (NEW.signed_group_sha256 IS NOT NULL)
 OR json_extract(NEW.observation,'$.receipt.reservationsMustRemainHeld') IS NOT 1 OR json_extract(NEW.observation,'$.receipt.durableTransitionRequired') IS NOT 1
 OR json_extract(NEW.observation,'$.receipt.settlementVerificationRequired') IS NOT 1 OR json_extract(NEW.observation,'$.receipt.atomicityProven') IS NOT 0
 OR json_extract(NEW.observation,'$.receipt.signingAllowed') IS NOT 0 OR json_extract(NEW.observation,'$.receipt.executionAllowed') IS NOT 0
 OR json_extract(NEW.observation,'$.receipt.completeLaunch') IS NOT 0 OR length(NEW.sha256)!=64 OR NEW.sha256 GLOB '*[^a-f0-9]*'
 OR json_type(NEW.observation,'$.receipt.packets') IS NOT 'array'
 OR json_array_length(NEW.observation,'$.receipt.packets') IS NOT (SELECT json_array_length(review,'$.packets') FROM pump_launch_reviews WHERE id=NEW.review_id AND owner_id=NEW.owner_id)
 THEN RAISE(ABORT,'Invalid group observation context or permission') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.observation,'$.receipt.packets') p JOIN pump_launch_reviews r ON r.id=NEW.review_id AND r.owner_id=NEW.owner_id
 WHERE json_extract(p.value,'$.index') IS NOT CAST(p.key AS INTEGER)
 OR json_extract(p.value,'$.unsignedPacketSha256') IS NOT json_extract(r.review,'$.packets['||p.key||'].sha256')
 OR json_extract(p.value,'$.signedPacketSha256') IS NOT json_extract(r.signed,'$.packets['||p.key||'].signedPacketSha256')
 OR json_extract(p.value,'$.signature') IS NOT json_extract(r.signed,'$.packets['||p.key||'].signature')
 OR (json_type(p.value,'$.finalized') IS NOT 'true' AND json_type(p.value,'$.finalized') IS NOT 'false')
 OR (json_extract(p.value,'$.finalized')=0 AND (json_type(p.value,'$.succeeded') IS NOT 'null' OR json_type(p.value,'$.slot') IS NOT 'null' OR json_type(p.value,'$.networkFeeRaw') IS NOT 'null'))
 OR (json_extract(p.value,'$.finalized')=1 AND ((json_type(p.value,'$.succeeded') IS NOT 'true' AND json_type(p.value,'$.succeeded') IS NOT 'false') OR json_type(p.value,'$.slot') IS NOT 'text'))
 OR (json_type(p.value,'$.networkFeeRaw') IS NOT 'null' AND json_type(p.value,'$.networkFeeRaw') IS NOT 'text'))
 OR json_extract(NEW.observation,'$.receipt.observedPacketCount') IS NOT (SELECT count(*) FROM json_each(NEW.observation,'$.receipt.packets') WHERE json_extract(value,'$.finalized')=1)
 OR json_extract(NEW.observation,'$.receipt.successfulPacketCount') IS NOT (SELECT count(*) FROM json_each(NEW.observation,'$.receipt.packets') WHERE json_extract(value,'$.succeeded')=1)
 OR json_extract(NEW.observation,'$.receipt.allPacketsFinalized') IS NOT (json_extract(NEW.observation,'$.receipt.observedPacketCount')=json_array_length(NEW.observation,'$.receipt.packets'))
 OR json_extract(NEW.observation,'$.receipt.allPacketsSucceeded') IS NOT (json_extract(NEW.observation,'$.receipt.successfulPacketCount')=json_array_length(NEW.observation,'$.receipt.packets'))
 OR json_extract(NEW.observation,'$.receipt.networkFeeUnresolved') IS NOT (EXISTS(SELECT 1 FROM json_each(NEW.observation,'$.receipt.packets') WHERE json_type(value,'$.networkFeeRaw')='null'))
 OR NEW.observed_state IS NOT CASE
 WHEN json_extract(NEW.observation,'$.receipt.observedPacketCount')=json_array_length(NEW.observation,'$.receipt.packets') THEN CASE
 WHEN json_extract(NEW.observation,'$.receipt.successfulPacketCount')=json_array_length(NEW.observation,'$.receipt.packets') THEN 'complete'
 WHEN json_extract(NEW.observation,'$.receipt.successfulPacketCount')=0 THEN 'failed' ELSE 'partial' END
 WHEN json_extract(NEW.observation,'$.receipt.observedPacketCount')>0 THEN 'partial'
 WHEN json_extract(NEW.observation,'$.receipt.expiry.pastExpiryMargin')=1 THEN CASE
 WHEN json_extract(NEW.observation,'$.receipt.expiry.mintAbsent')=1 THEN 'expired-unobserved' ELSE 'unknown' END
 ELSE 'pending' END
 THEN RAISE(ABORT,'Group observation packet scope or counts differ') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_group_observation_no_update BEFORE UPDATE ON pump_group_observations BEGIN SELECT RAISE(ABORT,'Immutable group observation'); END;
--> statement-breakpoint
CREATE TRIGGER pump_group_observation_no_delete BEFORE DELETE ON pump_group_observations BEGIN SELECT RAISE(ABORT,'Group observation history retained'); END;
