-- A buy-back that fails to sign is retried, not cancelled: its sell already
-- landed, so releasing the reservation must return it to the unsigned state.
DROP TRIGGER wallet_cleanup_transition;
--> statement-breakpoint
CREATE TRIGGER wallet_cleanup_transition BEFORE UPDATE OF state ON wallet_cleanups WHEN OLD.state<>NEW.state BEGIN
 SELECT CASE WHEN NOT ((OLD.state='awaiting_signature' AND NEW.state IN ('signing','cancelled')) OR (OLD.state='signing' AND NEW.state IN ('signed','cancelled','awaiting_signature')) OR (OLD.state='signed' AND NEW.state IN ('submitted','finalized','failed')) OR (OLD.state='submitted' AND NEW.state IN ('finalized','failed'))) THEN RAISE(ABORT,'Cleanup state transition unavailable') END;
END;
