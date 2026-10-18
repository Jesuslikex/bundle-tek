CREATE TABLE `exchange_funding_quote_gates` (
	`scope` text PRIMARY KEY NOT NULL,
	`next_allowed_at` integer NOT NULL,
	`claim_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `exchange_funding_quotes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`funder_revision` integer NOT NULL,
	`plan_document` text NOT NULL,
	`review` text NOT NULL,
	`provider_reference` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_exchange_funding_quotes_owner` ON `exchange_funding_quotes` (`owner_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER exchange_funding_quote_insert BEFORE INSERT ON exchange_funding_quotes
WHEN NOT coalesce(
 json_valid(NEW.review) AND json_valid(NEW.plan_document)
 AND json_extract(NEW.review,'$.format')='exchange-funding-quote-v1'
 AND json_extract(NEW.review,'$.provider')='ChangeNOW'
 AND json_extract(NEW.review,'$.id')=NEW.id
 AND json_extract(NEW.review,'$.planId')=NEW.plan_id
 AND json_extract(NEW.review,'$.revision')=NEW.plan_revision
 AND json_extract(NEW.review,'$.funderRevision')=NEW.funder_revision
 AND json_extract(NEW.review,'$.quotedAt')=NEW.created_at
 AND json_extract(NEW.review,'$.expiresAt')=NEW.expires_at
 AND json_type(NEW.review,'$.durableReview')='true'
 AND json_type(NEW.review,'$.orderCreationAllowed')='false'
 AND json_type(NEW.review,'$.fundingAllowed')='false'
 AND json_type(NEW.review,'$.signingAllowed')='false'
 AND json_type(NEW.review,'$.executionAllowed')='false'
 AND length(NEW.provider_reference) BETWEEN 1 AND 4096
 AND EXISTS(SELECT 1 FROM funding_plans p JOIN workspace_wallets w
 ON w.owner_id=p.owner_id AND w.chain='Solana' AND w.address=json_extract(p.document,'$.funderAddress')
 WHERE p.owner_id=NEW.owner_id AND p.id=NEW.plan_id AND p.revision=NEW.plan_revision
 AND p.document=NEW.plan_document AND p.archived=0 AND w.archived=0 AND w.revision=NEW.funder_revision
 AND json_extract(NEW.review,'$.planUpdatedAt')=p.updated_at
 AND json_extract(p.document,'$.source')='CEX' AND json_extract(p.document,'$.chain')='Solana'
 AND json_extract(p.document,'$.currency')='SOL'
 AND json_extract(NEW.review,'$.funder')=w.address),0)
BEGIN
 SELECT RAISE(ABORT,'Exchange quote requires current owned non-executable funding evidence');
END;
--> statement-breakpoint
CREATE TRIGGER exchange_funding_quote_immutable BEFORE UPDATE ON exchange_funding_quotes BEGIN
 SELECT RAISE(ABORT,'Exchange quote evidence is immutable');
END;
