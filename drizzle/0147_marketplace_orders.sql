CREATE TABLE marketplace_orders (
 id TEXT PRIMARY KEY NOT NULL,
 buyer_id TEXT NOT NULL,
 reservation_id TEXT NOT NULL,
 reservation_sha256 TEXT NOT NULL,
 buyer_wallet TEXT NOT NULL,
 payout_address TEXT NOT NULL,
 amount_lamports TEXT NOT NULL,
 addresses TEXT NOT NULL CHECK(json_valid(addresses) AND json_type(addresses)='array'),
 delivery_public_key TEXT NOT NULL,
 document TEXT NOT NULL CHECK(json_valid(document)),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
 state TEXT NOT NULL CHECK(state IN ('awaiting_payment','signed','submitted','paid','failed','cancelled')),
 signed TEXT,
 signature TEXT,
 receipt TEXT CHECK(receipt IS NULL OR json_valid(receipt)),
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(buyer_id,reservation_id),
 FOREIGN KEY(buyer_id,reservation_id) REFERENCES marketplace_reservations(buyer_id,id),
 CHECK((signed IS NULL AND signature IS NULL) OR (length(signed) BETWEEN 1 AND 1700 AND length(signature) BETWEEN 64 AND 88)),
 CHECK(state IN ('awaiting_payment','cancelled') OR signed IS NOT NULL),
 CHECK(state<>'paid' OR receipt IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX marketplace_orders_buyer_history ON marketplace_orders(buyer_id,created_at DESC,id DESC);
--> statement-breakpoint
CREATE INDEX marketplace_orders_state ON marketplace_orders(state,created_at);
--> statement-breakpoint
CREATE TABLE marketplace_deliveries (
 order_id TEXT NOT NULL REFERENCES marketplace_orders(id),
 address TEXT NOT NULL,
 operator_id TEXT NOT NULL,
 sender_public_key TEXT NOT NULL,
 nonce TEXT NOT NULL,
 ciphertext TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(order_id,address)
);
--> statement-breakpoint
CREATE TRIGGER marketplace_orders_insert BEFORE INSERT ON marketplace_orders BEGIN
 SELECT CASE WHEN NEW.state IS NOT 'awaiting_payment' OR NEW.signed IS NOT NULL OR NEW.signature IS NOT NULL OR NEW.receipt IS NOT NULL
 OR length(NEW.buyer_id) NOT BETWEEN 1 AND 256 OR length(NEW.document)>65536
 OR length(NEW.delivery_public_key)!=44
 OR NEW.amount_lamports NOT GLOB '[1-9]*' OR NEW.amount_lamports GLOB '*[^0-9]*' OR length(NEW.amount_lamports)>20
 OR json_extract(NEW.document,'$.format') IS NOT 'bundle-order-v1'
 OR json_extract(NEW.document,'$.id') IS NOT NEW.id
 OR json_extract(NEW.document,'$.sha256') IS NOT NEW.sha256
 OR json_extract(NEW.document,'$.buyerWallet') IS NOT NEW.buyer_wallet
 OR json_extract(NEW.document,'$.payoutAddress') IS NOT NEW.payout_address
 OR json_extract(NEW.document,'$.amountLamports') IS NOT NEW.amount_lamports
 OR json_extract(NEW.document,'$.deliveryPublicKey') IS NOT NEW.delivery_public_key
 OR json_extract(NEW.document,'$.reservationId') IS NOT NEW.reservation_id
 OR json_extract(NEW.document,'$.reservationSha256') IS NOT NEW.reservation_sha256
 OR json_extract(NEW.document,'$.expiresAt') IS NOT NEW.expires_at
 OR NEW.buyer_wallet=NEW.payout_address
 OR julianday(NEW.created_at) IS NULL OR julianday(NEW.expires_at) IS NULL
 OR abs((julianday(NEW.created_at)-julianday('now'))*86400)>1
 OR julianday(NEW.expires_at)<=julianday(NEW.created_at)
 OR NOT EXISTS(
  SELECT 1 FROM marketplace_reservations r WHERE r.buyer_id=NEW.buyer_id AND r.id=NEW.reservation_id AND r.context_sha256=NEW.reservation_sha256
  AND julianday(r.expires_at)>julianday('now') AND julianday(NEW.expires_at)<=julianday(r.expires_at)
  AND json_extract(r.document,'$.review.askingPriceLamports') IS NEW.amount_lamports
  AND json_array_length(r.document,'$.review.items')=json_array_length(NEW.addresses)
  AND NOT EXISTS(SELECT 1 FROM marketplace_reservation_releases c WHERE c.buyer_id=r.buyer_id AND c.reservation_id=r.id)
  AND NOT EXISTS(SELECT 1 FROM json_each(r.document,'$.review.items') i WHERE NOT EXISTS(SELECT 1 FROM json_each(NEW.addresses) a WHERE a.value=json_extract(i.value,'$.listing.address')))
 )
 OR NOT EXISTS(SELECT 1 FROM workspace_wallets w JOIN wallet_ownership_proofs p ON p.owner_id=w.owner_id AND p.chain='Solana' AND p.address=w.address WHERE w.owner_id=NEW.buyer_id AND w.chain='Solana' AND w.address=NEW.buyer_wallet AND w.archived=0)
 THEN RAISE(ABORT,'Invalid marketplace order') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM marketplace_orders o,json_each(o.addresses) old,json_each(NEW.addresses) incoming
  WHERE old.value=incoming.value AND o.state IN ('awaiting_payment','signed','submitted','paid')
  AND (o.state<>'awaiting_payment' OR julianday(o.expires_at)>julianday('now'))
 ) THEN RAISE(ABORT,'Marketplace wallet is already being sold') END;
END;
--> statement-breakpoint
CREATE TRIGGER marketplace_orders_update BEFORE UPDATE ON marketplace_orders BEGIN
 SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.buyer_id IS NOT OLD.buyer_id OR NEW.reservation_id IS NOT OLD.reservation_id OR NEW.reservation_sha256 IS NOT OLD.reservation_sha256
 OR NEW.buyer_wallet IS NOT OLD.buyer_wallet OR NEW.payout_address IS NOT OLD.payout_address OR NEW.amount_lamports IS NOT OLD.amount_lamports
 OR NEW.addresses IS NOT OLD.addresses OR NEW.delivery_public_key IS NOT OLD.delivery_public_key OR NEW.document IS NOT OLD.document
 OR NEW.sha256 IS NOT OLD.sha256 OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
 OR (OLD.signed IS NOT NULL AND (NEW.signed IS NOT OLD.signed OR NEW.signature IS NOT OLD.signature))
 OR (OLD.receipt IS NOT NULL AND NEW.receipt IS NOT OLD.receipt)
 OR NOT ((OLD.state='awaiting_payment' AND NEW.state IN ('signed','cancelled'))
  OR (OLD.state='signed' AND NEW.state IN ('submitted','cancelled'))
  OR (OLD.state='submitted' AND NEW.state IN ('paid','failed')))
 OR (NEW.signed IS NOT OLD.signed AND NOT (OLD.state='awaiting_payment' AND NEW.state='signed'))
 OR (NEW.state IN ('signed','submitted') AND julianday('now')>=julianday(OLD.expires_at))
 OR (NEW.state='paid' AND NEW.receipt IS NULL)
 THEN RAISE(ABORT,'Invalid marketplace order transition') END;
 SELECT CASE WHEN NEW.state='submitted' AND NOT EXISTS(
  SELECT 1 FROM marketplace_reservations r WHERE r.buyer_id=OLD.buyer_id AND r.id=OLD.reservation_id AND julianday(r.expires_at)>julianday('now')
  AND NOT EXISTS(SELECT 1 FROM marketplace_reservation_releases c WHERE c.buyer_id=r.buyer_id AND c.reservation_id=r.id)
 ) THEN RAISE(ABORT,'Marketplace reservation is no longer held') END;
END;
--> statement-breakpoint
CREATE TRIGGER marketplace_orders_no_delete BEFORE DELETE ON marketplace_orders BEGIN
 SELECT RAISE(ABORT,'Marketplace orders are retained');
END;
--> statement-breakpoint
CREATE TRIGGER marketplace_orders_hold_release BEFORE INSERT ON marketplace_reservation_releases BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM marketplace_orders o WHERE o.buyer_id=NEW.buyer_id AND o.reservation_id=NEW.reservation_id AND o.state IN ('signed','submitted','paid'))
 THEN RAISE(ABORT,'A paid or pending marketplace order keeps this reservation') END;
END;
--> statement-breakpoint
CREATE TRIGGER marketplace_orders_sold_wallets BEFORE INSERT ON marketplace_reservations BEGIN
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM marketplace_orders o,json_each(o.addresses) sold,json_each(NEW.document,'$.review.items') incoming
  WHERE sold.value=json_extract(incoming.value,'$.listing.address') AND o.state IN ('signed','submitted','paid')
 ) THEN RAISE(ABORT,'Marketplace wallet is already sold') END;
END;
--> statement-breakpoint
CREATE TRIGGER marketplace_deliveries_insert BEFORE INSERT ON marketplace_deliveries BEGIN
 SELECT CASE WHEN length(NEW.operator_id) NOT BETWEEN 1 AND 256
 OR length(NEW.sender_public_key)!=44 OR length(NEW.nonce)!=32 OR length(NEW.ciphertext) NOT BETWEEN 64 AND 128
 OR julianday(NEW.created_at) IS NULL OR abs((julianday(NEW.created_at)-julianday('now'))*86400)>1
 OR NOT EXISTS(SELECT 1 FROM marketplace_orders o,json_each(o.addresses) a WHERE o.id=NEW.order_id AND o.state='paid' AND a.value=NEW.address)
 OR NOT EXISTS(SELECT 1 FROM marketplace_publications p WHERE p.owner_id=NEW.operator_id AND p.wallet_address=NEW.address)
 THEN RAISE(ABORT,'Invalid marketplace delivery') END;
END;
--> statement-breakpoint
CREATE TRIGGER marketplace_deliveries_no_update BEFORE UPDATE ON marketplace_deliveries BEGIN
 SELECT RAISE(ABORT,'Marketplace deliveries are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER marketplace_deliveries_no_delete BEFORE DELETE ON marketplace_deliveries BEGIN
 SELECT RAISE(ABORT,'Marketplace deliveries are immutable');
END;
