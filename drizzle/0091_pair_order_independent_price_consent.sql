CREATE TRIGGER pair_order_auth_independent_price_consent BEFORE INSERT ON pair_order_first_authorizations BEGIN
 SELECT CASE WHEN COALESCE(json_type(NEW.document,'$.consent.acknowledgeUnavailableIndependentPrice'),'missing') NOT IN ('true','false') OR (EXISTS(SELECT 1 FROM pair_order_first_reviews r WHERE r.id=NEW.review_id AND json_type(r.document,'$.review.marketComparison.available') IS NOT 'true') AND json_type(NEW.document,'$.consent.acknowledgeUnavailableIndependentPrice') IS NOT 'true') THEN RAISE(ABORT,'Independent price unavailable acknowledgement required') END;
END;
