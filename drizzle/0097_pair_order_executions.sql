CREATE TABLE pair_order_executions (
 authorization_id TEXT PRIMARY KEY NOT NULL REFERENCES pair_order_first_authorizations(id),
 review_id TEXT NOT NULL UNIQUE REFERENCES pair_order_first_reviews(id), owner_id TEXT NOT NULL, wallet TEXT NOT NULL,
 packet TEXT NOT NULL CHECK(length(packet) BETWEEN 1 AND 1644), packet_sha256 TEXT NOT NULL CHECK(length(packet_sha256)=64),
 input_mint TEXT NOT NULL, output_mint TEXT NOT NULL, minimum_output_raw TEXT NOT NULL, last_valid_block_height TEXT NOT NULL,
 authorization_expires_at TEXT NOT NULL, review_expires_at TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('reserved','signed','submitting','submitted','finalized','failed','expired')),
 signed_packet TEXT CHECK(signed_packet IS NULL OR length(signed_packet) BETWEEN 1 AND 1644), signature TEXT, signed_at TEXT,
 send_consent TEXT CHECK(send_consent IS NULL OR json_valid(send_consent)), submitting_at TEXT,
 receipt TEXT CHECK(receipt IS NULL OR json_valid(receipt)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK((signed_packet IS NULL)=(signature IS NULL) AND (signature IS NULL)=(signed_at IS NULL)),
 CHECK((send_consent IS NULL)=(submitting_at IS NULL)),
 CHECK(state NOT IN ('signed','submitting','submitted','finalized','failed') OR signature IS NOT NULL),
 CHECK(state NOT IN ('submitting','submitted','finalized','failed') OR send_consent IS NOT NULL),
 CHECK(state NOT IN ('finalized','failed','expired') OR receipt IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX pair_order_executions_active_wallet ON pair_order_executions(owner_id,wallet) WHERE state IN ('reserved','signed','submitting','submitted');
--> statement-breakpoint
CREATE TRIGGER pair_order_execution_insert BEFORE INSERT ON pair_order_executions BEGIN
 SELECT CASE WHEN NEW.state IS NOT 'reserved' OR NEW.signed_packet IS NOT NULL OR NEW.send_consent IS NOT NULL OR NEW.receipt IS NOT NULL
 OR julianday('now')>=julianday(NEW.authorization_expires_at)
 OR NOT EXISTS(SELECT 1 FROM pair_order_first_authorizations a JOIN pair_order_first_reviews r ON r.id=a.review_id AND r.owner_id=a.owner_id
 WHERE a.id=NEW.authorization_id AND a.review_id=NEW.review_id AND a.owner_id=NEW.owner_id AND r.wallet=NEW.wallet
 AND a.expires_at=NEW.authorization_expires_at AND r.expires_at=NEW.review_expires_at
 AND json_extract(a.document,'$.packetSha256')=NEW.packet_sha256 AND json_extract(a.document,'$.minimumOutputRaw')=NEW.minimum_output_raw
 AND json_extract(a.document,'$.scope')='sign-exact-reviewed-packet-only'
 AND json_extract(r.document,'$.candidate.order.preparation.transaction')=NEW.packet
 AND json_extract(r.document,'$.candidate.order.preparation.sha256')=NEW.packet_sha256
 AND json_extract(r.document,'$.candidate.order.preparation.lastValidBlockHeight')=NEW.last_valid_block_height
 AND json_extract(r.document,'$.review.inputMint')=NEW.input_mint AND json_extract(r.document,'$.review.outputMint')=NEW.output_mint)
 THEN RAISE(ABORT,'Exact pair execution authorization required') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM solana_execution_reservations WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet)
 OR EXISTS(SELECT 1 FROM pump_launch_reviews r WHERE r.owner_id=NEW.owner_id AND r.state NOT IN ('cancelled','failed','finalized') AND (r.payer=NEW.wallet
 OR EXISTS(SELECT 1 FROM json_each(r.review,'$.input.holders') h WHERE json_extract(r.review,'$.format') IN ('pump-create-holders-review-v1','pump-launch-group-review-v1')
 AND json_extract(h.value,'$.kind')!='none' AND json_extract(h.value,'$.address')=NEW.wallet)))
 THEN RAISE(ABORT,'Pair wallet already reserved') END;
END;
--> statement-breakpoint
CREATE TRIGGER pair_order_execution_shared_reservation BEFORE INSERT ON solana_execution_reservations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pair_order_executions e WHERE e.owner_id=NEW.owner_id AND e.wallet=NEW.wallet_address
 AND e.state IN ('reserved','signed','submitting','submitted')) THEN RAISE(ABORT,'Wallet reserved for stock pair order') END;
END;
--> statement-breakpoint
CREATE TRIGGER pair_order_execution_shared_reservation_update BEFORE UPDATE OF owner_id,wallet_address ON solana_execution_reservations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pair_order_executions e WHERE e.owner_id=NEW.owner_id AND e.wallet=NEW.wallet_address
 AND e.state IN ('reserved','signed','submitting','submitted')) THEN RAISE(ABORT,'Wallet reserved for stock pair order') END;
END;
--> statement-breakpoint
CREATE TRIGGER pair_order_execution_launch_reservation BEFORE INSERT ON pump_launch_reviews BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pair_order_executions e WHERE e.owner_id=NEW.owner_id AND e.state IN ('reserved','signed','submitting','submitted')
 AND (e.wallet=NEW.payer OR e.wallet IN (SELECT json_extract(value,'$.address') FROM json_each(NEW.review,'$.input.holders')
 WHERE json_extract(NEW.review,'$.format') IN ('pump-create-holders-review-v1','pump-launch-group-review-v1') AND json_extract(value,'$.kind')!='none')))
 THEN RAISE(ABORT,'Wallet reserved for stock pair order') END;
END;
--> statement-breakpoint
CREATE TRIGGER pair_order_execution_transition BEFORE UPDATE ON pair_order_executions BEGIN
 SELECT CASE WHEN NEW.authorization_id IS NOT OLD.authorization_id OR NEW.review_id IS NOT OLD.review_id OR NEW.owner_id IS NOT OLD.owner_id
 OR NEW.wallet IS NOT OLD.wallet OR NEW.packet IS NOT OLD.packet OR NEW.packet_sha256 IS NOT OLD.packet_sha256 OR NEW.input_mint IS NOT OLD.input_mint
 OR NEW.output_mint IS NOT OLD.output_mint OR NEW.minimum_output_raw IS NOT OLD.minimum_output_raw OR NEW.last_valid_block_height IS NOT OLD.last_valid_block_height
 OR NEW.authorization_expires_at IS NOT OLD.authorization_expires_at OR NEW.review_expires_at IS NOT OLD.review_expires_at OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.signed_packet IS NOT NULL AND (NEW.signed_packet IS NOT OLD.signed_packet OR NEW.signature IS NOT OLD.signature OR NEW.signed_at IS NOT OLD.signed_at))
 OR (OLD.send_consent IS NOT NULL AND (NEW.send_consent IS NOT OLD.send_consent OR NEW.submitting_at IS NOT OLD.submitting_at))
 OR OLD.receipt IS NOT NULL OR OLD.state IN ('finalized','failed','expired')
 THEN RAISE(ABORT,'Immutable pair execution evidence') END;
 SELECT CASE WHEN NOT (
 (OLD.state='reserved' AND NEW.state='signed' AND OLD.signed_packet IS NULL AND NEW.signed_packet IS NOT NULL AND NEW.send_consent IS NULL AND NEW.receipt IS NULL
  AND julianday('now')<=julianday(OLD.authorization_expires_at)+15.0/86400 AND julianday('now')<julianday(OLD.review_expires_at))
 OR (OLD.state='reserved' AND NEW.state='expired' AND NEW.signed_packet IS NULL AND NEW.send_consent IS NULL AND NEW.receipt IS NOT NULL
  AND julianday('now')>julianday(OLD.authorization_expires_at)+15.0/86400)
 OR (OLD.state='signed' AND NEW.state='submitting' AND OLD.send_consent IS NULL AND NEW.send_consent IS NOT NULL AND NEW.receipt IS NULL
  AND json_extract(NEW.send_consent,'$.signature') IS OLD.signature AND json_extract(NEW.send_consent,'$.authorizationId') IS OLD.authorization_id
  AND json_extract(NEW.send_consent,'$.packetSha256') IS OLD.packet_sha256 AND json_extract(NEW.send_consent,'$.sendExactSignedPacketOnce') IS 1
  AND julianday('now')<julianday(OLD.review_expires_at))
 OR (OLD.state='submitting' AND NEW.state='submitted' AND NEW.receipt IS NULL)
 OR (OLD.state IN ('signed','submitting','submitted') AND NEW.state IN ('finalized','failed','expired') AND NEW.receipt IS NOT NULL
  AND NEW.send_consent IS OLD.send_consent)
 ) THEN RAISE(ABORT,'Invalid pair execution transition') END;
END;
--> statement-breakpoint
CREATE TRIGGER pair_order_execution_no_delete BEFORE DELETE ON pair_order_executions BEGIN SELECT RAISE(ABORT,'Immutable pair execution evidence'); END;
