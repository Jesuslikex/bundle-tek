-- Cleanup buy-back leg: after a sell finalizes, the paired buyer buys the token
-- with the SOL it received. Buys are their own document format.
DROP TRIGGER wallet_cleanup_insert;
--> statement-breakpoint
CREATE TRIGGER wallet_cleanup_insert BEFORE INSERT ON wallet_cleanups BEGIN
 SELECT CASE WHEN NEW.state<>'awaiting_signature' OR NEW.signature IS NOT NULL OR NEW.receipt IS NOT NULL OR NEW.failure IS NOT NULL THEN RAISE(ABORT,'Cleanup must start unsigned') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM solana_execution_reservations WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet_address) THEN RAISE(ABORT,'Wallet already reserved') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM wallet_cleanups WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet_address AND batch_id<>NEW.batch_id AND state IN ('awaiting_signature','signing','signed','submitted')) THEN RAISE(ABORT,'Wallet already reserved by another cleanup') END;
 SELECT CASE WHEN json_extract(NEW.document,'$.format')='wallet-cleanup-v1' AND EXISTS(SELECT 1 FROM wallet_cleanups WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet_address AND state IN ('awaiting_signature','signing','signed','submitted')) THEN RAISE(ABORT,'Wallet already reserved by another cleanup') END;
 SELECT CASE WHEN json_extract(NEW.document,'$.format') NOT IN ('wallet-cleanup-v1','wallet-cleanup-sell-v1','wallet-cleanup-buy-v1') THEN RAISE(ABORT,'Unknown cleanup format') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pump_launch_reviews r WHERE r.owner_id=NEW.owner_id AND r.state NOT IN ('cancelled','failed','finalized') AND (r.payer=NEW.wallet_address OR NEW.wallet_address IN (
  SELECT json_extract(value,'$.address') FROM json_each(r.review,'$.input.holders') WHERE json_extract(r.review,'$.format') IN ('pump-create-holders-review-v1','pump-launch-group-review-v1') AND json_extract(value,'$.kind')!='none'))) THEN RAISE(ABORT,'Wallet reserved for launch') END;
END;
