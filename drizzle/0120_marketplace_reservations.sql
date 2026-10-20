CREATE TABLE marketplace_reservations (
 id TEXT PRIMARY KEY,
 buyer_id TEXT NOT NULL,
 context_sha256 TEXT NOT NULL,
 request_sha256 TEXT NOT NULL,
 document TEXT NOT NULL CHECK(json_valid(document)),
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 UNIQUE(buyer_id,id)
);
--> statement-breakpoint
CREATE INDEX marketplace_reservations_expiry ON marketplace_reservations(expires_at);
--> statement-breakpoint
CREATE TABLE marketplace_reservation_releases (
 buyer_id TEXT NOT NULL,
 reservation_id TEXT NOT NULL,
 context_sha256 TEXT NOT NULL,
 released_at TEXT NOT NULL,
 acknowledgement TEXT NOT NULL,
 PRIMARY KEY(buyer_id,reservation_id),
 FOREIGN KEY(buyer_id,reservation_id) REFERENCES marketplace_reservations(buyer_id,id)
);
--> statement-breakpoint
CREATE TRIGGER marketplace_reservations_insert BEFORE INSERT ON marketplace_reservations BEGIN
 SELECT CASE WHEN length(NEW.id)!=36 OR NEW.id GLOB '*[^a-f0-9-]*' OR length(replace(NEW.id,'-',''))!=32
 OR substr(NEW.id,9,1)!='-' OR substr(NEW.id,14,1)!='-' OR substr(NEW.id,19,1)!='-' OR substr(NEW.id,24,1)!='-'
 OR length(NEW.buyer_id) NOT BETWEEN 1 AND 256 OR length(NEW.document)>524288
 OR length(NEW.context_sha256)!=64 OR NEW.context_sha256 GLOB '*[^a-f0-9]*'
 OR length(NEW.request_sha256)!=64 OR NEW.request_sha256 GLOB '*[^a-f0-9]*'
 OR json_extract(NEW.document,'$.format') IS NOT 'bundle-reservation-v1'
 OR json_extract(NEW.document,'$.id') IS NOT NEW.id
 OR json_extract(NEW.document,'$.contextSha256') IS NOT NEW.context_sha256
 OR json_extract(NEW.document,'$.requestSha256') IS NOT NEW.request_sha256
 OR json_extract(NEW.document,'$.createdAt') IS NOT NEW.created_at
 OR json_extract(NEW.document,'$.expiresAt') IS NOT NEW.expires_at
 OR json_type(NEW.document,'$.reserved') IS NOT 'true'
 OR json_type(NEW.document,'$.purchaseEnabled') IS NOT 'false'
 OR json_type(NEW.document,'$.paymentEnabled') IS NOT 'false'
 OR json_type(NEW.document,'$.deliveryEnabled') IS NOT 'false'
 OR json_type(NEW.document,'$.signingAllowed') IS NOT 'false'
 OR json_extract(NEW.document,'$.acknowledgement') IS NOT 'Hold these exact wallets and asking prices for five minutes. This does not authorize payment, purchase, signing or key delivery. Bundle is the seller; previous private-key copies may exist.'
 OR json_extract(NEW.document,'$.review.format') IS NOT 'bundle-cart-review-v1'
 OR json_extract(NEW.document,'$.review.chain') IS NOT 'Solana'
 OR json_extract(NEW.document,'$.review.seller') IS NOT 'Bundle'
 OR json_type(NEW.document,'$.review.items') IS NOT 'array'
 OR json_array_length(NEW.document,'$.review.items') NOT BETWEEN 1 AND 200
 OR json_extract(NEW.document,'$.review.count') IS NOT json_array_length(NEW.document,'$.review.items')
 OR json_type(NEW.document,'$.review.reserved') IS NOT 'false'
 OR json_type(NEW.document,'$.review.purchaseEnabled') IS NOT 'false'
 OR json_type(NEW.document,'$.review.paymentEnabled') IS NOT 'false'
 OR json_type(NEW.document,'$.review.deliveryEnabled') IS NOT 'false'
 OR json_type(NEW.document,'$.review.signingAllowed') IS NOT 'false'
 OR json_type(NEW.document,'$.review.networkFeeLamports') IS NOT 'null'
 OR julianday(NEW.created_at) IS NULL OR julianday(NEW.expires_at) IS NULL
 OR abs((julianday(NEW.expires_at)-julianday(NEW.created_at))*86400-300)>0.001
 OR abs((julianday(NEW.created_at)-julianday('now'))*86400)>1
 OR julianday(json_extract(NEW.document,'$.review.reviewedAt')) IS NULL
 OR julianday(json_extract(NEW.document,'$.review.catalogObservedAt')) IS NULL
 OR julianday(json_extract(NEW.document,'$.review.expiresAt')) IS NULL
 OR abs((julianday(json_extract(NEW.document,'$.review.expiresAt'))-julianday(json_extract(NEW.document,'$.review.catalogObservedAt')))*86400-60)>0.001
 OR julianday(json_extract(NEW.document,'$.review.catalogObservedAt'))>julianday(json_extract(NEW.document,'$.review.reviewedAt'))
 OR julianday(json_extract(NEW.document,'$.review.reviewedAt'))>julianday(NEW.created_at)
 OR julianday(NEW.created_at)>=julianday(json_extract(NEW.document,'$.review.expiresAt'))
 OR julianday('now')>=julianday(json_extract(NEW.document,'$.review.expiresAt'))
 OR (SELECT count(DISTINCT json_extract(value,'$.id')) FROM json_each(NEW.document,'$.review.items'))!=json_array_length(NEW.document,'$.review.items')
 OR (SELECT count(DISTINCT json_extract(value,'$.listing.address')) FROM json_each(NEW.document,'$.review.items'))!=json_array_length(NEW.document,'$.review.items')
 THEN RAISE(ABORT,'Invalid marketplace reservation') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM json_each(NEW.document,'$.review.items') e WHERE NOT EXISTS(
   SELECT 1 FROM marketplace_publications p JOIN marketplace_operator_drafts d ON d.owner_id=p.owner_id AND d.id=p.draft_id
   JOIN workspace_wallets w ON w.owner_id=p.owner_id AND w.chain='Solana' AND w.address=p.wallet_address
   JOIN wallet_ownership_proofs proof ON proof.owner_id=p.owner_id AND proof.chain='Solana' AND proof.address=p.wallet_address
   WHERE p.id=json_extract(e.value,'$.id') AND p.published_at=json_extract(e.value,'$.publishedAt')
   AND p.wallet_address=json_extract(e.value,'$.listing.address')
   AND json_extract(p.document,'$.preview.listing')=json_extract(e.value,'$.listing')
   AND w.archived=0 AND w.revision=d.wallet_revision
   AND w.label=json_extract(d.document,'$.review.evidence.label') AND w.updated_at=json_extract(d.document,'$.review.evidence.updatedAt')
   AND proof.verified_at=json_extract(d.document,'$.review.evidence.ownershipProofAt')
   AND NOT EXISTS(SELECT 1 FROM marketplace_withdrawals x WHERE x.owner_id=p.owner_id AND x.publication_id=p.id)
  )
 ) THEN RAISE(ABORT,'Marketplace reservation source changed') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM marketplace_reservations r,json_each(r.document,'$.review.items') old,json_each(NEW.document,'$.review.items') incoming
  WHERE julianday(r.expires_at)>julianday('now')
  AND json_extract(old.value,'$.listing.address')=json_extract(incoming.value,'$.listing.address')
  AND NOT EXISTS(SELECT 1 FROM marketplace_reservation_releases c WHERE c.buyer_id=r.buyer_id AND c.reservation_id=r.id)
 ) THEN RAISE(ABORT,'Marketplace wallet is already reserved') END;
END;
--> statement-breakpoint
CREATE TRIGGER marketplace_reservations_no_update BEFORE UPDATE ON marketplace_reservations BEGIN
 SELECT RAISE(ABORT,'Marketplace reservations are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER marketplace_reservations_no_delete BEFORE DELETE ON marketplace_reservations BEGIN
 SELECT RAISE(ABORT,'Marketplace reservations are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER marketplace_reservation_releases_insert BEFORE INSERT ON marketplace_reservation_releases BEGIN
 SELECT CASE WHEN NEW.acknowledgement IS NOT 'Release this exact wallet reservation. This does not send or refund a payment.'
 OR julianday(NEW.released_at) IS NULL OR abs((julianday(NEW.released_at)-julianday('now'))*86400)>1
 OR NOT EXISTS(SELECT 1 FROM marketplace_reservations r WHERE r.buyer_id=NEW.buyer_id AND r.id=NEW.reservation_id AND r.context_sha256=NEW.context_sha256 AND julianday(NEW.released_at)>=julianday(r.created_at))
 THEN RAISE(ABORT,'Invalid marketplace reservation release') END;
END;
--> statement-breakpoint
CREATE TRIGGER marketplace_reservation_releases_no_update BEFORE UPDATE ON marketplace_reservation_releases BEGIN
 SELECT RAISE(ABORT,'Marketplace reservation releases are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER marketplace_reservation_releases_no_delete BEFORE DELETE ON marketplace_reservation_releases BEGIN
 SELECT RAISE(ABORT,'Marketplace reservation releases are immutable');
END;
