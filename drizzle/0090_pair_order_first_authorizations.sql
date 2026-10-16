CREATE TABLE pair_order_first_authorizations (
 id TEXT PRIMARY KEY NOT NULL, review_id TEXT NOT NULL UNIQUE REFERENCES pair_order_first_reviews(id), owner_id TEXT NOT NULL,
 document TEXT NOT NULL CHECK(json_valid(document)), created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 CHECK(julianday(expires_at)>julianday(created_at)),
 CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at),
 CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS expires_at),
 CHECK((CAST(strftime('%s',expires_at) AS INTEGER)-CAST(strftime('%s',created_at) AS INTEGER))*1000+CAST(substr(strftime('%f',expires_at),4,3) AS INTEGER)-CAST(substr(strftime('%f',created_at),4,3) AS INTEGER)<=5000)
);
--> statement-breakpoint
CREATE TRIGGER pair_order_auth_owned BEFORE INSERT ON pair_order_first_authorizations BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pair_order_first_reviews r JOIN imported_token_projects p ON p.id=r.project_id AND p.owner_id=r.owner_id JOIN workspace_wallets w ON w.owner_id=r.owner_id AND w.address=r.wallet AND w.chain='Solana' JOIN wallet_ownership_proofs o ON o.owner_id=w.owner_id AND o.chain=w.chain AND o.address=w.address WHERE r.id=NEW.review_id AND r.owner_id=NEW.owner_id AND p.revision=r.project_revision AND p.archived=0 AND w.archived=0 AND w.revision=r.wallet_revision AND julianday(r.expires_at)>=julianday(NEW.expires_at) AND json_extract(NEW.document,'$.reviewSha256')=json_extract(r.document,'$.review.sha256') AND json_extract(NEW.document,'$.packetSha256')=json_extract(r.document,'$.review.packetSha256') AND json_extract(NEW.document,'$.minimumOutputRaw')=json_extract(r.document,'$.review.minimumOutputRaw')) THEN RAISE(ABORT,'Pair authorization ownership changed') END;
 SELECT CASE WHEN json_extract(NEW.document,'$.id') IS NOT NEW.id OR json_extract(NEW.document,'$.createdAt') IS NOT NEW.created_at OR json_extract(NEW.document,'$.expiresAt') IS NOT NEW.expires_at OR json_extract(NEW.document,'$.scope') IS NOT 'sign-exact-reviewed-packet-only' OR json_extract(NEW.document,'$.signingAllowed') IS NOT 1 OR json_extract(NEW.document,'$.executionAllowed') IS NOT 0 OR json_extract(NEW.document,'$.submissionAllowed') IS NOT 0 THEN RAISE(ABORT,'Exact signing authorization required') END;
 SELECT CASE WHEN json_extract(NEW.document,'$.consent.approveExactOrder') IS NOT 1 OR json_extract(NEW.document,'$.consent.reviewSha256') IS NOT json_extract(NEW.document,'$.reviewSha256') OR json_extract(NEW.document,'$.consent.packetSha256') IS NOT json_extract(NEW.document,'$.packetSha256') OR json_extract(NEW.document,'$.consent.approvedMinimumOutputRaw') IS NOT json_extract(NEW.document,'$.minimumOutputRaw') OR (EXISTS(SELECT 1 FROM pair_order_first_reviews r WHERE r.id=NEW.review_id AND json_extract(r.document,'$.review.acknowledgementRequired')=1) AND json_extract(NEW.document,'$.consent.acknowledgeIndependentDifference') IS NOT 1) THEN RAISE(ABORT,'Exact order consent required') END;
END;
--> statement-breakpoint
CREATE TRIGGER pair_order_auth_no_update BEFORE UPDATE ON pair_order_first_authorizations BEGIN SELECT RAISE(ABORT,'Immutable pair authorization'); END;
--> statement-breakpoint
CREATE TRIGGER pair_order_auth_no_delete BEFORE DELETE ON pair_order_first_authorizations BEGIN SELECT RAISE(ABORT,'Immutable pair authorization'); END;
