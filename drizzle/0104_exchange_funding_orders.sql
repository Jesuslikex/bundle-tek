CREATE TABLE `exchange_funding_order_approvals` (
	`review_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`sha256` text NOT NULL,
	`consent` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `exchange_funding_order_reviews`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `exchange_funding_order_attempts` (
	`review_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `exchange_funding_order_reviews`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exchange_funding_order_attempts_id_unique` ON `exchange_funding_order_attempts` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_exchange_order_one_attempt_per_draft` ON `exchange_funding_order_attempts` (`owner_id`,`plan_id`);--> statement-breakpoint
CREATE TABLE `exchange_funding_order_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`document` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `exchange_funding_order_attempts`(`review_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_exchange_order_observations_owner` ON `exchange_funding_order_observations` (`owner_id`,`review_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `exchange_funding_order_references` (
	`review_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `exchange_funding_order_attempts`(`review_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `exchange_funding_order_results` (
	`review_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`outcome` text NOT NULL,
	`document` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `exchange_funding_order_attempts`(`review_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `exchange_funding_order_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`quote_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`refund_address` text NOT NULL,
	`refund_revision` integer NOT NULL,
	`document` text NOT NULL,
	`sha256` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exchange_funding_order_reviews_quote_id_unique` ON `exchange_funding_order_reviews` (`quote_id`);--> statement-breakpoint
CREATE INDEX `idx_exchange_order_reviews_owner` ON `exchange_funding_order_reviews` (`owner_id`,`created_at`);
--> statement-breakpoint
CREATE VIEW exchange_funding_order_current_context AS
SELECT r.id,r.owner_id,r.plan_id,r.sha256,r.created_at,r.expires_at FROM exchange_funding_order_reviews r
JOIN exchange_funding_quotes q ON q.owner_id=r.owner_id AND q.id=r.quote_id AND q.plan_id=r.plan_id
JOIN funding_plans p ON p.owner_id=q.owner_id AND p.id=q.plan_id
JOIN workspace_wallets f ON f.owner_id=q.owner_id AND f.chain='Solana' AND f.address=json_extract(q.review,'$.funder')
JOIN workspace_wallets w ON w.owner_id=q.owner_id AND w.chain='Solana' AND w.address=r.refund_address
WHERE p.archived=0 AND p.revision=q.plan_revision AND p.document=q.plan_document
AND p.updated_at=json_extract(q.review,'$.planUpdatedAt') AND f.archived=0 AND f.revision=q.funder_revision
AND w.archived=0 AND w.revision=r.refund_revision
AND EXISTS(SELECT 1 FROM wallet_ownership_proofs x WHERE x.owner_id=r.owner_id AND x.chain='Solana' AND x.address=f.address)
AND EXISTS(SELECT 1 FROM wallet_ownership_proofs x WHERE x.owner_id=r.owner_id AND x.chain='Solana' AND x.address=w.address);
--> statement-breakpoint
CREATE TRIGGER exchange_order_review_insert BEFORE INSERT ON exchange_funding_order_reviews
WHEN NOT coalesce(json_valid(NEW.document)
AND json_extract(NEW.document,'$.format')='exchange-order-review-v1'
AND json_extract(NEW.document,'$.id')=NEW.id
AND json_extract(NEW.document,'$.quote.id')=NEW.quote_id
AND json_extract(NEW.document,'$.quote.planId')=NEW.plan_id
AND json_extract(NEW.document,'$.refund.address')=NEW.refund_address
AND json_extract(NEW.document,'$.refund.revision')=NEW.refund_revision
AND json_extract(NEW.document,'$.createdAt')=NEW.created_at
AND json_extract(NEW.document,'$.expiresAt')=NEW.expires_at
AND json_type(NEW.document,'$.orderCreationAllowed')='false'
AND json_type(NEW.document,'$.depositInstructionsAllowed')='false'
AND json_type(NEW.document,'$.fundingAllowed')='false'
AND json_type(NEW.document,'$.signingAllowed')='false'
AND json_type(NEW.document,'$.executionAllowed')='false'
AND length(NEW.sha256)=64 AND NEW.sha256 NOT GLOB '*[^0-9a-f]*'
AND NOT EXISTS(SELECT 1 FROM exchange_funding_order_attempts a WHERE a.owner_id=NEW.owner_id AND a.plan_id=NEW.plan_id)
AND EXISTS(SELECT 1 FROM exchange_funding_quotes q
JOIN funding_plans p ON p.owner_id=q.owner_id AND p.id=q.plan_id
JOIN workspace_wallets f ON f.owner_id=q.owner_id AND f.chain='Solana' AND f.address=json_extract(q.review,'$.funder')
JOIN workspace_wallets w ON w.owner_id=q.owner_id AND w.chain='Solana' AND w.address=NEW.refund_address
WHERE q.owner_id=NEW.owner_id AND q.id=NEW.quote_id AND q.plan_id=NEW.plan_id
AND json(q.review)=json_extract(NEW.document,'$.quote')
AND p.archived=0 AND p.revision=q.plan_revision AND p.document=q.plan_document
AND p.updated_at=json_extract(q.review,'$.planUpdatedAt') AND f.archived=0 AND f.revision=q.funder_revision
AND w.archived=0 AND w.revision=NEW.refund_revision AND w.address<>f.address
AND NEW.created_at>=json_extract(q.review,'$.quotedAt') AND NEW.created_at<q.expires_at AND NEW.expires_at=q.expires_at
AND EXISTS(SELECT 1 FROM wallet_ownership_proofs x WHERE x.owner_id=q.owner_id AND x.chain='Solana' AND x.address=f.address)
AND EXISTS(SELECT 1 FROM wallet_ownership_proofs x WHERE x.owner_id=q.owner_id AND x.chain='Solana' AND x.address=w.address)),0)
BEGIN
 SELECT RAISE(ABORT,'Exchange order review requires current owned proven context');
END;
--> statement-breakpoint
CREATE TRIGGER exchange_order_approval_insert BEFORE INSERT ON exchange_funding_order_approvals
WHEN NOT coalesce(json_valid(NEW.consent)
AND json_extract(NEW.consent,'$.reviewId')=NEW.review_id AND json_extract(NEW.consent,'$.sha256')=NEW.sha256
AND json_type(NEW.consent,'$.exactAmountsAndNetwork')='true'
AND json_type(NEW.consent,'$.providerCustody')='true'
AND json_type(NEW.consent,'$.verificationMayBeRequired')='true'
AND json_type(NEW.consent,'$.refundAddressReviewed')='true'
AND EXISTS(SELECT 1 FROM exchange_funding_order_current_context r WHERE r.id=NEW.review_id AND r.owner_id=NEW.owner_id AND r.sha256=NEW.sha256 AND NEW.created_at>=r.created_at AND NEW.created_at<r.expires_at),0)
BEGIN
 SELECT RAISE(ABORT,'Exchange order approval requires exact separate consent and current context');
END;
--> statement-breakpoint
CREATE TRIGGER exchange_order_attempt_insert BEFORE INSERT ON exchange_funding_order_attempts
WHEN NOT coalesce(EXISTS(SELECT 1 FROM exchange_funding_order_current_context r
JOIN exchange_funding_order_approvals a ON a.review_id=r.id AND a.owner_id=r.owner_id AND a.sha256=r.sha256
WHERE r.id=NEW.review_id AND r.owner_id=NEW.owner_id AND r.plan_id=NEW.plan_id
AND NEW.created_at>=a.created_at AND NEW.created_at<r.expires_at
AND NEW.created_at<strftime('%Y-%m-%dT%H:%M:%fZ',a.created_at,'+5 seconds')),0)
BEGIN
 SELECT RAISE(ABORT,'Exchange order attempt requires fresh exact approval');
END;
--> statement-breakpoint
CREATE TRIGGER exchange_order_reference_insert BEFORE INSERT ON exchange_funding_order_references
WHEN NOT coalesce(length(NEW.provider_id) BETWEEN 1 AND 80 AND NEW.provider_id NOT GLOB '*[^a-zA-Z0-9_-]*'
AND EXISTS(SELECT 1 FROM exchange_funding_order_attempts a WHERE a.review_id=NEW.review_id AND a.owner_id=NEW.owner_id),0)
BEGIN
 SELECT RAISE(ABORT,'Exchange provider reference requires its owned attempt');
END;
--> statement-breakpoint
CREATE TRIGGER exchange_order_result_insert BEFORE INSERT ON exchange_funding_order_results
WHEN NOT coalesce(json_valid(NEW.document) AND NEW.outcome IN ('matched','unresolved')
AND json_extract(NEW.document,'$.format')='exchange-order-result-v1'
AND json_extract(NEW.document,'$.outcome')=NEW.outcome
AND json_type(NEW.document,'$.transportEntered') IN ('true','false')
AND (NEW.outcome='unresolved' OR json_type(NEW.document,'$.transportEntered')='true')
AND json_type(NEW.document,'$.payoutVerified')='false' AND json_type(NEW.document,'$.refundVerified')='false'
AND json_type(NEW.document,'$.orderCreationAllowed')='false' AND json_type(NEW.document,'$.depositInstructionsAllowed')='false'
AND json_type(NEW.document,'$.fundingAllowed')='false' AND json_type(NEW.document,'$.signingAllowed')='false' AND json_type(NEW.document,'$.executionAllowed')='false'
AND EXISTS(SELECT 1 FROM exchange_funding_order_attempts a WHERE a.review_id=NEW.review_id AND a.owner_id=NEW.owner_id)
AND (NEW.outcome='unresolved' OR EXISTS(SELECT 1 FROM exchange_funding_order_references r WHERE r.review_id=NEW.review_id AND r.owner_id=NEW.owner_id AND r.provider_id=json_extract(NEW.document,'$.order.providerId'))),0)
BEGIN
 SELECT RAISE(ABORT,'Exchange result cannot grant payment or payout authority');
END;
--> statement-breakpoint
CREATE TRIGGER exchange_order_observation_insert BEFORE INSERT ON exchange_funding_order_observations
WHEN NOT coalesce(json_valid(NEW.document) AND json_extract(NEW.document,'$.format')='exchange-order-observation-v1'
AND json_type(NEW.document,'$.payoutVerified')='false' AND json_type(NEW.document,'$.refundVerified')='false'
AND json_type(NEW.document,'$.orderCreationAllowed')='false' AND json_type(NEW.document,'$.depositInstructionsAllowed')='false'
AND json_type(NEW.document,'$.fundingAllowed')='false' AND json_type(NEW.document,'$.signingAllowed')='false' AND json_type(NEW.document,'$.executionAllowed')='false'
AND json_extract(NEW.document,'$.providerStatus') IN ('new','waiting','confirming','exchanging','sending','finished','failed','refunded','verifying')
AND EXISTS(SELECT 1 FROM exchange_funding_order_references r JOIN exchange_funding_order_reviews v ON v.id=r.review_id AND v.owner_id=r.owner_id
WHERE r.review_id=NEW.review_id AND r.owner_id=NEW.owner_id AND r.provider_id=json_extract(NEW.document,'$.providerId')
AND json_extract(NEW.document,'$.payoutAddress')=json_extract(v.document,'$.quote.funder')
AND json_extract(NEW.document,'$.refundAddress')=v.refund_address
AND json_extract(NEW.document,'$.depositLamports')=json_extract(v.document,'$.quote.depositLamports')
AND json_extract(NEW.document,'$.expectedPayoutLamports')=json_extract(v.document,'$.quote.expectedPayoutLamports'))
AND NOT EXISTS(SELECT 1 FROM exchange_funding_order_results x WHERE x.review_id=NEW.review_id AND x.owner_id=NEW.owner_id AND x.outcome='matched'
AND json_extract(x.document,'$.order.depositAddress')<>json_extract(NEW.document,'$.depositAddress'))
AND NOT EXISTS(SELECT 1 FROM exchange_funding_order_observations x WHERE x.review_id=NEW.review_id AND x.owner_id=NEW.owner_id
AND (json_extract(x.document,'$.depositAddress')<>json_extract(NEW.document,'$.depositAddress')
OR (json_extract(x.document,'$.providerStatus') IN ('finished','refunded','failed') AND json_extract(x.document,'$.providerStatus')<>json_extract(NEW.document,'$.providerStatus')))),0)
BEGIN
 SELECT RAISE(ABORT,'Exchange observation requires its retained reference and grants no payout authority');
END;
--> statement-breakpoint
CREATE TRIGGER exchange_order_review_immutable BEFORE UPDATE ON exchange_funding_order_reviews BEGIN SELECT RAISE(ABORT,'Exchange order review is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER exchange_order_approval_immutable BEFORE UPDATE ON exchange_funding_order_approvals BEGIN SELECT RAISE(ABORT,'Exchange order approval is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER exchange_order_attempt_immutable BEFORE UPDATE ON exchange_funding_order_attempts BEGIN SELECT RAISE(ABORT,'Exchange order attempt is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER exchange_order_reference_immutable BEFORE UPDATE ON exchange_funding_order_references BEGIN SELECT RAISE(ABORT,'Exchange order reference is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER exchange_order_result_immutable BEFORE UPDATE ON exchange_funding_order_results BEGIN SELECT RAISE(ABORT,'Exchange order result is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER exchange_order_observation_immutable BEFORE UPDATE ON exchange_funding_order_observations BEGIN SELECT RAISE(ABORT,'Exchange order observation is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER exchange_order_review_retain BEFORE DELETE ON exchange_funding_order_reviews BEGIN SELECT RAISE(ABORT,'Retain exchange order review'); END;
--> statement-breakpoint
CREATE TRIGGER exchange_order_approval_retain BEFORE DELETE ON exchange_funding_order_approvals BEGIN SELECT RAISE(ABORT,'Retain exchange order approval'); END;
--> statement-breakpoint
CREATE TRIGGER exchange_order_attempt_retain BEFORE DELETE ON exchange_funding_order_attempts BEGIN SELECT RAISE(ABORT,'Retain exchange order attempt'); END;
--> statement-breakpoint
CREATE TRIGGER exchange_order_reference_retain BEFORE DELETE ON exchange_funding_order_references BEGIN SELECT RAISE(ABORT,'Retain exchange order reference'); END;
--> statement-breakpoint
CREATE TRIGGER exchange_order_result_retain BEFORE DELETE ON exchange_funding_order_results BEGIN SELECT RAISE(ABORT,'Retain exchange order result'); END;
--> statement-breakpoint
CREATE TRIGGER exchange_order_observation_retain BEFORE DELETE ON exchange_funding_order_observations BEGIN SELECT RAISE(ABORT,'Retain exchange order observation'); END;
--> statement-breakpoint
CREATE TRIGGER exchange_order_quote_retain BEFORE DELETE ON exchange_funding_quotes
WHEN EXISTS(SELECT 1 FROM exchange_funding_order_reviews r WHERE r.quote_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Retain quote linked to an exchange order review'); END;
