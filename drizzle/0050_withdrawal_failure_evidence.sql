ALTER TABLE native_withdrawals ADD COLUMN failure_receipt TEXT CHECK(failure_receipt IS NULL OR (state='failed' AND json_valid(failure_receipt) AND length(failure_receipt)<=4096 AND json_extract(failure_receipt,'$.failed')=1));
--> statement-breakpoint
ALTER TABLE native_withdrawal_events ADD COLUMN failure_receipt TEXT CHECK(failure_receipt IS NULL OR (state='failed' AND json_valid(failure_receipt) AND length(failure_receipt)<=4096));
--> statement-breakpoint
CREATE TRIGGER native_withdrawal_failure_identity BEFORE UPDATE ON native_withdrawals WHEN OLD.failure_receipt IS NOT NULL AND (NEW.failure_receipt IS NULL OR NEW.failure_receipt<>OLD.failure_receipt) BEGIN SELECT RAISE(ABORT,'Withdrawal failure evidence is immutable'); END;
--> statement-breakpoint
DROP TRIGGER native_withdrawal_transition;
--> statement-breakpoint
CREATE TRIGGER native_withdrawal_transition AFTER UPDATE OF state ON native_withdrawals WHEN OLD.state<>NEW.state BEGIN
 SELECT CASE WHEN NOT ((OLD.state='awaiting_signature' AND NEW.state IN ('signing','cancelled')) OR (OLD.state='signing' AND NEW.state IN ('signed','cancelled')) OR (OLD.state='signed' AND NEW.state IN ('submitted','finalized','failed')) OR (OLD.state='submitted' AND NEW.state IN ('finalized','failed'))) THEN RAISE(ABORT,'Withdrawal state transition unavailable') END;
 UPDATE solana_execution_reservations SET state=NEW.state WHERE owner_id=NEW.owner_id AND scope='withdrawal' AND intent_id=NEW.id;
 DELETE FROM solana_execution_reservations WHERE owner_id=NEW.owner_id AND scope='withdrawal' AND intent_id=NEW.id AND NEW.state IN ('finalized','failed','cancelled');
 INSERT INTO native_withdrawal_events(owner_id,intent_id,wallet_address,state,signature,created_at,failure_receipt) VALUES(NEW.owner_id,NEW.id,NEW.wallet_address,NEW.state,NEW.signature,NEW.updated_at,NEW.failure_receipt);
END;
--> statement-breakpoint
CREATE TRIGGER native_withdrawal_failure_recovery AFTER UPDATE OF failure_receipt ON native_withdrawals WHEN OLD.state='failed' AND NEW.state='failed' AND OLD.failure_receipt IS NULL AND NEW.failure_receipt IS NOT NULL BEGIN
 INSERT INTO native_withdrawal_events(owner_id,intent_id,wallet_address,state,signature,created_at,failure_receipt) VALUES(NEW.owner_id,NEW.id,NEW.wallet_address,NEW.state,NEW.signature,NEW.updated_at,NEW.failure_receipt);
END;
