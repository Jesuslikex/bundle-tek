CREATE TABLE `exchange_funding_payout_receipts` (
 `review_id` text PRIMARY KEY NOT NULL REFERENCES exchange_funding_order_attempts(review_id),
 `owner_id` text NOT NULL,
 `observation_id` text NOT NULL REFERENCES exchange_funding_order_observations(id),
 `signature` text NOT NULL,
 `recipient` text NOT NULL,
 `amount_raw` text NOT NULL,
 `document` text NOT NULL,
 `sha256` text NOT NULL,
 `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_exchange_payout_once_per_recipient` ON `exchange_funding_payout_receipts` (`signature`,`recipient`);
--> statement-breakpoint
CREATE TRIGGER exchange_observation_hash_pin BEFORE INSERT ON exchange_funding_order_observations
WHEN EXISTS (
 SELECT 1 FROM json_each('["payinHash","payoutHash","refundHash"]') k
 WHERE (json_extract(NEW.document,'$.'||k.value) IS NOT NULL AND (
 json_type(NEW.document,'$.'||k.value)<>'text'
 OR length(json_extract(NEW.document,'$.'||k.value)) NOT BETWEEN 64 AND 88
 OR json_extract(NEW.document,'$.'||k.value) GLOB '*[^1-9A-HJ-NP-Za-km-z]*'))
 OR EXISTS (SELECT 1 FROM exchange_funding_order_observations x
 WHERE x.review_id=NEW.review_id AND x.owner_id=NEW.owner_id
 AND length(json_extract(x.document,'$.'||k.value))>0
 AND json_extract(NEW.document,'$.'||k.value) IS NOT NULL
 AND json_extract(x.document,'$.'||k.value)<>json_extract(NEW.document,'$.'||k.value))
)
BEGIN SELECT RAISE(ABORT,'Exchange transaction reference changed or is malformed'); END;
--> statement-breakpoint
CREATE TRIGGER exchange_payout_receipt_insert BEFORE INSERT ON exchange_funding_payout_receipts
WHEN NOT coalesce(json_valid(NEW.document)
AND json_extract(NEW.document,'$.format')='exchange-payout-receipt-v1'
AND json_extract(NEW.document,'$.reviewId')=NEW.review_id
AND json_extract(NEW.document,'$.signature')=NEW.signature
AND json_extract(NEW.document,'$.recipient')=NEW.recipient
AND json_type(NEW.document,'$.amountRaw')='text' AND json_extract(NEW.document,'$.amountRaw')=NEW.amount_raw
AND json_extract(NEW.document,'$.network')='solana-mainnet'
AND json_extract(NEW.document,'$.observedAt')=NEW.created_at
AND json_type(NEW.document,'$.signatureVerified')='true' AND json_type(NEW.document,'$.payoutVerified')='true'
AND json_type(NEW.document,'$.currentSpendabilityVerified')='false'
AND json_extract(NEW.document,'$.finalityEvidence')='rpc-attestation'
AND json_extract(NEW.document,'$.accountEffects')='recipient-native-credit-only'
AND json_type(NEW.document,'$.orderCreationAllowed')='false' AND json_type(NEW.document,'$.depositInstructionsAllowed')='false'
AND json_type(NEW.document,'$.fundingAllowed')='false' AND json_type(NEW.document,'$.signingAllowed')='false' AND json_type(NEW.document,'$.executionAllowed')='false'
AND length(NEW.signature) BETWEEN 64 AND 88 AND NEW.signature NOT GLOB '*[^1-9A-HJ-NP-Za-km-z]*'
AND length(NEW.sha256)=64 AND NEW.sha256 NOT GLOB '*[^a-f0-9]*'
AND length(json_extract(NEW.document,'$.packetSha256'))=64 AND json_extract(NEW.document,'$.packetSha256') NOT GLOB '*[^a-f0-9]*'
AND json_type(NEW.document,'$.slot')='integer' AND json_extract(NEW.document,'$.slot')>=0
AND json_type(NEW.document,'$.finalizedSlot')='integer' AND json_extract(NEW.document,'$.finalizedSlot')>=json_extract(NEW.document,'$.slot')
AND json_type(NEW.document,'$.statusContextSlot')='integer' AND json_extract(NEW.document,'$.statusContextSlot')>=json_extract(NEW.document,'$.slot')
AND EXISTS(SELECT 1 FROM exchange_funding_order_reviews r
JOIN exchange_funding_order_attempts a ON a.review_id=r.id AND a.owner_id=r.owner_id
JOIN exchange_funding_order_references p ON p.review_id=r.id AND p.owner_id=r.owner_id
JOIN exchange_funding_order_observations o ON o.review_id=r.id AND o.owner_id=r.owner_id
WHERE r.id=NEW.review_id AND r.owner_id=NEW.owner_id AND o.id=NEW.observation_id
AND json_extract(o.document,'$.providerId')=p.provider_id AND json_extract(o.document,'$.providerStatus')='finished'
AND json_extract(o.document,'$.payoutHash')=NEW.signature
AND json_extract(o.document,'$.payoutAddress')=NEW.recipient
AND json_extract(r.document,'$.quote.funder')=NEW.recipient
AND json_extract(r.document,'$.quote.expectedPayoutLamports')=NEW.amount_raw
AND json_extract(NEW.document,'$.orderSha256')=r.sha256
AND NEW.created_at>=o.created_at AND NEW.created_at>=a.created_at
AND json_extract(NEW.document,'$.blockTime')*1000>=cast(round((julianday(a.created_at)-2440587.5)*86400000) AS INTEGER)
AND json_extract(NEW.document,'$.blockTime')*1000<=cast(round((julianday(NEW.created_at)-2440587.5)*86400000) AS INTEGER))
AND NOT EXISTS(SELECT 1 FROM exchange_funding_order_observations o WHERE o.review_id=NEW.review_id AND o.owner_id=NEW.owner_id
AND length(json_extract(o.document,'$.payoutHash'))>0 AND json_extract(o.document,'$.payoutHash')<>NEW.signature),0)
BEGIN SELECT RAISE(ABORT,'Exchange payout receipt requires the exact owned finished observation'); END;
--> statement-breakpoint
CREATE TRIGGER exchange_payout_receipt_immutable BEFORE UPDATE ON exchange_funding_payout_receipts BEGIN SELECT RAISE(ABORT,'Exchange payout receipt is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER exchange_payout_receipt_retain BEFORE DELETE ON exchange_funding_payout_receipts BEGIN SELECT RAISE(ABORT,'Retain exchange payout receipt'); END;
