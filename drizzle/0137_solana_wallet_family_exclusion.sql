CREATE VIEW solana_scheduled_family_holds AS
 SELECT 'organic' AS family,s.id,s.owner_id,json_extract(w.value,'$.address') AS wallet_address FROM pump_organic_sequences s,json_each(s.plan,'$.rows') w
 WHERE s.state='active' OR EXISTS(SELECT 1 FROM pump_organic_batches b JOIN pump_organic_buys t ON t.batch_id=b.id
 WHERE b.sequence_id=s.id AND t.state IN ('signed','submitting','submitted'))
 UNION ALL
 SELECT 'organic',s.id,s.owner_id,t.holder FROM pump_organic_buys t
 JOIN pump_organic_batches b ON b.id=t.batch_id JOIN pump_organic_sequences s ON s.id=b.sequence_id
 WHERE t.state IN ('signed','submitting','submitted')
 UNION ALL
 SELECT 'volume',s.id,s.owner_id,w.value FROM volume_bot_sessions s,json_each(s.plan,'$.wallets') w
 WHERE s.state='active' OR EXISTS(SELECT 1 FROM volume_bot_batches b JOIN volume_bot_trades t ON t.batch_id=b.id
 WHERE b.session_id=s.id AND t.state IN ('signed','submitting','submitted'))
 UNION ALL
 SELECT 'volume',s.id,s.owner_id,t.wallet FROM volume_bot_trades t
 JOIN volume_bot_batches b ON b.id=t.batch_id JOIN volume_bot_sessions s ON s.id=b.session_id
 WHERE t.state IN ('signed','submitting','submitted');
--> statement-breakpoint
CREATE VIEW solana_wallet_family_holds AS
 SELECT 'cleanup' AS family,id,owner_id,wallet_address FROM wallet_cleanups
 WHERE state IN ('awaiting_signature','signing','signed','submitted')
 UNION ALL
 SELECT 'supply',id,owner_id,wallet_address FROM token_supply_actions
 WHERE state IN ('awaiting_signature','signing','signed','submitted')
 UNION ALL
 SELECT family,id,owner_id,wallet_address FROM solana_scheduled_family_holds;
--> statement-breakpoint
CREATE TRIGGER solana_family_shared_wallet_update BEFORE UPDATE OF owner_id,wallet_address ON solana_execution_reservations BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(
 SELECT 1 FROM solana_wallet_family_holds h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address);
END;
--> statement-breakpoint
CREATE TRIGGER wallet_cleanup_family_insert BEFORE INSERT ON wallet_cleanups BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(
 SELECT 1 FROM solana_wallet_family_holds h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address AND h.family<>'cleanup');
END;
--> statement-breakpoint
CREATE TRIGGER token_supply_family_insert BEFORE INSERT ON token_supply_actions BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(
 SELECT 1 FROM solana_wallet_family_holds h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address);
END;
--> statement-breakpoint
CREATE TRIGGER pump_organic_family_insert BEFORE INSERT ON pump_organic_sequences BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(
 SELECT 1 FROM solana_wallet_family_holds h,json_each(NEW.plan,'$.rows') w
 WHERE h.owner_id=NEW.owner_id AND h.wallet_address=json_extract(w.value,'$.address'));
END;
--> statement-breakpoint
CREATE TRIGGER volume_bot_family_insert BEFORE INSERT ON volume_bot_sessions BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(
 SELECT 1 FROM solana_wallet_family_holds h,json_each(NEW.plan,'$.wallets') w
 WHERE h.owner_id=NEW.owner_id AND h.wallet_address=w.value);
END;
--> statement-breakpoint
CREATE TRIGGER wallet_cleanup_family_sign_or_send BEFORE UPDATE OF state ON wallet_cleanups
WHEN NEW.state IN ('signing','submitted') AND NEW.state<>OLD.state BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(
 SELECT 1 FROM solana_wallet_family_holds h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address AND h.family<>'cleanup')
 OR EXISTS(SELECT 1 FROM solana_execution_reservations WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet_address);
END;
--> statement-breakpoint
CREATE TRIGGER token_supply_family_sign_or_send BEFORE UPDATE OF state ON token_supply_actions
WHEN NEW.state IN ('signing','submitted') AND NEW.state<>OLD.state BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(
 SELECT 1 FROM solana_wallet_family_holds h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address AND (h.family<>'supply' OR h.id<>NEW.id))
 OR EXISTS(SELECT 1 FROM solana_execution_reservations WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet_address);
END;
--> statement-breakpoint
CREATE TRIGGER pump_organic_family_reactivate BEFORE UPDATE OF state ON pump_organic_sequences
WHEN NEW.state='active' AND OLD.state<>'active' BEGIN
 SELECT RAISE(ABORT,'Organic sequence cannot be reactivated');
END;
--> statement-breakpoint
CREATE TRIGGER volume_bot_family_reactivate BEFORE UPDATE OF state ON volume_bot_sessions
WHEN NEW.state='active' AND OLD.state<>'active' BEGIN
 SELECT RAISE(ABORT,'Volume session cannot be reactivated');
END;
--> statement-breakpoint
CREATE TRIGGER pump_organic_family_send BEFORE UPDATE OF state ON pump_organic_buys
WHEN NEW.state='submitting' AND OLD.state<>'submitting' BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(
 SELECT 1 FROM solana_wallet_family_holds h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.holder
 AND (h.family<>'organic' OR h.id IS NOT (SELECT sequence_id FROM pump_organic_batches WHERE id=NEW.batch_id)))
 OR EXISTS(SELECT 1 FROM solana_execution_reservations WHERE owner_id=NEW.owner_id AND wallet_address=NEW.holder);
END;
--> statement-breakpoint
CREATE TRIGGER volume_bot_family_send BEFORE UPDATE OF state ON volume_bot_trades
WHEN NEW.state='submitting' AND OLD.state<>'submitting' BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(
 SELECT 1 FROM solana_wallet_family_holds h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet
 AND (h.family<>'volume' OR h.id IS NOT (SELECT session_id FROM volume_bot_batches WHERE id=NEW.batch_id)))
 OR EXISTS(SELECT 1 FROM solana_execution_reservations WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet);
END;
--> statement-breakpoint
CREATE TRIGGER pump_organic_family_identity BEFORE UPDATE ON pump_organic_sequences
WHEN NEW.id IS NOT OLD.id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.project_id IS NOT OLD.project_id
 OR NEW.launch_review_id IS NOT OLD.launch_review_id OR NEW.mint IS NOT OLD.mint OR NEW.rent_allowance_raw IS NOT OLD.rent_allowance_raw
 OR NEW.plan IS NOT OLD.plan OR NEW.plan_sha256 IS NOT OLD.plan_sha256 OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'Organic sequence identity is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER volume_bot_family_identity BEFORE UPDATE ON volume_bot_sessions
WHEN NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'Volume session identity is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER pump_organic_family_batch BEFORE INSERT ON pump_organic_batches BEGIN
 SELECT RAISE(ABORT,'Organic sequence is not active or wallet already reserved') WHERE NOT EXISTS(
 SELECT 1 FROM pump_organic_sequences s WHERE s.id=NEW.sequence_id AND s.owner_id=NEW.owner_id AND s.state='active')
 OR EXISTS(SELECT 1 FROM pump_organic_sequences s,json_each(s.plan,'$.rows') w,solana_wallet_family_holds h
 WHERE s.id=NEW.sequence_id AND h.owner_id=NEW.owner_id AND h.wallet_address=json_extract(w.value,'$.address') AND (h.family<>'organic' OR h.id<>s.id))
 OR EXISTS(SELECT 1 FROM pump_organic_sequences s,json_each(s.plan,'$.rows') w,solana_execution_reservations h
 WHERE s.id=NEW.sequence_id AND h.owner_id=NEW.owner_id AND h.wallet_address=json_extract(w.value,'$.address'));
END;
--> statement-breakpoint
CREATE TRIGGER volume_bot_family_batch BEFORE INSERT ON volume_bot_batches BEGIN
 SELECT RAISE(ABORT,'Volume session is not active or wallet already reserved') WHERE NOT EXISTS(
 SELECT 1 FROM volume_bot_sessions s WHERE s.id=NEW.session_id AND s.owner_id=NEW.owner_id AND s.state='active')
 OR EXISTS(SELECT 1 FROM volume_bot_sessions s,json_each(s.plan,'$.wallets') w,solana_wallet_family_holds h
 WHERE s.id=NEW.session_id AND h.owner_id=NEW.owner_id AND h.wallet_address=w.value AND (h.family<>'volume' OR h.id<>s.id))
 OR EXISTS(SELECT 1 FROM volume_bot_sessions s,json_each(s.plan,'$.wallets') w,solana_execution_reservations h
 WHERE s.id=NEW.session_id AND h.owner_id=NEW.owner_id AND h.wallet_address=w.value);
END;
--> statement-breakpoint
CREATE TRIGGER pump_organic_family_member BEFORE INSERT ON pump_organic_buys BEGIN
 SELECT RAISE(ABORT,'Organic signed wallet differs from its saved sequence') WHERE NOT EXISTS(
 SELECT 1 FROM pump_organic_batches b JOIN pump_organic_sequences s ON s.id=b.sequence_id,json_each(s.plan,'$.rows') w
 WHERE b.id=NEW.batch_id AND b.owner_id=NEW.owner_id AND s.owner_id=NEW.owner_id AND b.state='signed' AND json_extract(w.value,'$.address')=NEW.holder);
END;
--> statement-breakpoint
CREATE TRIGGER volume_bot_family_member BEFORE INSERT ON volume_bot_trades BEGIN
 SELECT RAISE(ABORT,'Volume signed wallet differs from its saved session') WHERE NOT EXISTS(
 SELECT 1 FROM volume_bot_batches b JOIN volume_bot_sessions s ON s.id=b.session_id,json_each(s.plan,'$.wallets') w
 WHERE b.id=NEW.batch_id AND b.owner_id=NEW.owner_id AND s.owner_id=NEW.owner_id AND b.state='signed' AND w.value=NEW.wallet);
END;
