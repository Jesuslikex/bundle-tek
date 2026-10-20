CREATE INDEX marketplace_reservations_buyer_history ON marketplace_reservations(buyer_id,created_at DESC,id DESC);
