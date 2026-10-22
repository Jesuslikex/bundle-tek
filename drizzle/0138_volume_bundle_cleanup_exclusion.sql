CREATE TRIGGER volume_bundle_cleanup_insert BEFORE INSERT ON volume_bundle_reservations BEGIN
 SELECT RAISE(ABORT,'Volume wallet reserved by cleanup') WHERE EXISTS(
 SELECT 1 FROM wallet_cleanups c WHERE c.owner_id=NEW.owner_id AND c.wallet_address=NEW.wallet
 AND c.state IN ('awaiting_signature','signing','signed','submitted'));
END;
--> statement-breakpoint
CREATE TRIGGER volume_bundle_cleanup_attempt BEFORE UPDATE OF state ON volume_bundle_reservations
WHEN NEW.state='attempted' AND OLD.state<>'attempted' BEGIN
 SELECT RAISE(ABORT,'Volume wallet reserved by cleanup') WHERE EXISTS(
 SELECT 1 FROM wallet_cleanups c WHERE c.owner_id=NEW.owner_id AND c.wallet_address=NEW.wallet
 AND c.state IN ('awaiting_signature','signing','signed','submitted'));
END;
--> statement-breakpoint
CREATE TRIGGER wallet_cleanup_volume_bundle_insert BEFORE INSERT ON wallet_cleanups BEGIN
 SELECT RAISE(ABORT,'Wallet reserved by same-block Volume') WHERE EXISTS(
 SELECT 1 FROM volume_bundle_reservations r WHERE r.owner_id=NEW.owner_id AND r.wallet=NEW.wallet_address AND r.state IN ('held','attempted'));
END;
--> statement-breakpoint
CREATE TRIGGER wallet_cleanup_volume_bundle_sign_or_send BEFORE UPDATE OF state ON wallet_cleanups
WHEN NEW.state IN ('signing','submitted') AND NEW.state<>OLD.state BEGIN
 SELECT RAISE(ABORT,'Wallet reserved by same-block Volume') WHERE EXISTS(
 SELECT 1 FROM volume_bundle_reservations r WHERE r.owner_id=NEW.owner_id AND r.wallet=NEW.wallet_address AND r.state IN ('held','attempted'));
END;
