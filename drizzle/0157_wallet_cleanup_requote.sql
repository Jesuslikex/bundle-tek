-- A cleanup document is a draft until it is signed. Re-quoting an expired
-- buy-back rewrites the document in place, so the identity trigger must allow
-- that while the row is still unsigned.
DROP TRIGGER wallet_cleanup_identity;
--> statement-breakpoint
CREATE TRIGGER wallet_cleanup_identity BEFORE UPDATE ON wallet_cleanups WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.batch_id<>OLD.batch_id OR NEW.wallet_address<>OLD.wallet_address OR NEW.wallet_revision<>OLD.wallet_revision OR NEW.destination<>OLD.destination OR (NEW.document<>OLD.document AND NOT (OLD.state='awaiting_signature' AND OLD.signature IS NULL)) OR NEW.created_at<>OLD.created_at OR (OLD.signature IS NOT NULL AND (NEW.signature IS NULL OR NEW.signature<>OLD.signature)) OR (OLD.receipt IS NOT NULL AND (NEW.receipt IS NULL OR NEW.receipt<>OLD.receipt)) OR (OLD.failure IS NOT NULL AND (NEW.failure IS NULL OR NEW.failure<>OLD.failure)) BEGIN SELECT RAISE(ABORT,'Cleanup context is immutable'); END;
