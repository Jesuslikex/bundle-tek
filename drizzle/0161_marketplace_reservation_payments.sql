-- A hold is not a purchase. This records the buyer's own signed SOL transfer to
-- the seller, so settlement can require payment instead of assuming it.
CREATE TABLE IF NOT EXISTS marketplace_reservation_payments (
  buyer_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  lamports TEXT NOT NULL,
  seller_wallet TEXT NOT NULL,
  paid_at TEXT NOT NULL,
  PRIMARY KEY (buyer_id, reservation_id)
);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS marketplace_reservation_payments_no_update
BEFORE UPDATE ON marketplace_reservation_payments BEGIN
 SELECT RAISE(ABORT,'Marketplace reservation payments are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS marketplace_reservation_payments_no_delete
BEFORE DELETE ON marketplace_reservation_payments BEGIN
 SELECT RAISE(ABORT,'Marketplace reservation payments are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS marketplace_reservation_payments_insert
BEFORE INSERT ON marketplace_reservation_payments BEGIN
 SELECT CASE WHEN length(NEW.buyer_id) NOT BETWEEN 1 AND 256
 OR length(NEW.reservation_id)!=36
 OR length(NEW.signature) NOT BETWEEN 64 AND 100
 OR NEW.signature GLOB '*[^1-9A-HJ-NP-Za-km-z]*'
 OR NEW.lamports GLOB '*[^0-9]*'
 OR length(NEW.lamports) NOT BETWEEN 1 AND 20
 OR substr(NEW.lamports,1,1) NOT BETWEEN '1' AND '9'
 OR length(NEW.seller_wallet) NOT BETWEEN 32 AND 44
 OR NEW.seller_wallet GLOB '*[^1-9A-HJ-NP-Za-km-z]*'
 OR julianday(NEW.paid_at) IS NULL
 THEN RAISE(ABORT,'Invalid marketplace reservation payment') END;
END;
