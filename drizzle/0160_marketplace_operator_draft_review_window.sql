-- The listing review window moved from 60s to 180s. The insert guard pinned the
-- old value in SQL, so the app constant alone would reject every save.
DROP TRIGGER marketplace_operator_drafts_insert;
--> statement-breakpoint
CREATE TRIGGER marketplace_operator_drafts_insert BEFORE INSERT ON marketplace_operator_drafts BEGIN
 SELECT CASE WHEN length(NEW.owner_id) NOT BETWEEN 1 AND 256
 OR length(NEW.id)!=36 OR NEW.id GLOB '*[^a-f0-9-]*' OR length(replace(NEW.id,'-',''))!=32
 OR substr(NEW.id,9,1)!='-' OR substr(NEW.id,14,1)!='-' OR substr(NEW.id,19,1)!='-' OR substr(NEW.id,24,1)!='-'
 OR length(NEW.wallet_address) NOT BETWEEN 32 AND 44
 OR typeof(NEW.wallet_revision)!='integer' OR NEW.wallet_revision NOT BETWEEN 1 AND 1000000000
 OR length(NEW.review_sha256)!=64 OR NEW.review_sha256 GLOB '*[^a-f0-9]*'
 OR length(CAST(NEW.document AS BLOB))>16384
 OR json_extract(NEW.document,'$.format') IS NOT 'bundle-operator-draft-v1'
 OR json_extract(NEW.document,'$.id') IS NOT NEW.id
 OR json_extract(NEW.document,'$.createdAt') IS NOT NEW.created_at
 OR json_extract(NEW.document,'$.reviewSha256') IS NOT NEW.review_sha256
 OR json_extract(NEW.document,'$.acknowledgement') IS NOT 'Save this exact unpublished draft. This does not publish a listing, accept payment or authorize key delivery.'
 OR json_type(NEW.document,'$.publicationAllowed') IS NOT 'false'
 OR json_type(NEW.document,'$.paymentAllowed') IS NOT 'false'
 OR json_type(NEW.document,'$.deliveryAllowed') IS NOT 'false'
 OR json_type(NEW.document,'$.signingAllowed') IS NOT 'false'
 OR json_extract(NEW.document,'$.review.format') IS NOT 'bundle-operator-listing-review-v1'
 OR json_extract(NEW.document,'$.review.sellerModel') IS NOT 'bundle-operated'
 OR json_extract(NEW.document,'$.review.disclosure') IS NOT 'Bundle is the only seller. Historical control proofs do not prove exclusive custody; the seller may retain a copy of the key. Recorded activity does not establish wallet creation, first funding or organic trading.'
 OR json_type(NEW.document,'$.review.listingAllowed') IS NOT 'false'
 OR json_type(NEW.document,'$.review.paymentAllowed') IS NOT 'false'
 OR json_type(NEW.document,'$.review.deliveryAllowed') IS NOT 'false'
 OR json_type(NEW.document,'$.review.signingAllowed') IS NOT 'false'
 OR json_extract(NEW.document,'$.review.selection.address') IS NOT NEW.wallet_address
 OR json_extract(NEW.document,'$.review.selection.walletRevision') IS NOT NEW.wallet_revision
 OR json_extract(NEW.document,'$.review.evidence.address') IS NOT NEW.wallet_address
 OR json_extract(NEW.document,'$.review.evidence.revision') IS NOT NEW.wallet_revision
 OR json_type(NEW.document,'$.review.selection.priceLamports') IS NOT 'text'
 OR json_extract(NEW.document,'$.review.selection.priceLamports') GLOB '*[^0-9]*'
 OR substr(json_extract(NEW.document,'$.review.selection.priceLamports'),1,1) NOT BETWEEN '1' AND '9'
 OR length(json_extract(NEW.document,'$.review.selection.priceLamports')) NOT BETWEEN 1 AND 20
 OR (length(json_extract(NEW.document,'$.review.selection.priceLamports'))=20 AND json_extract(NEW.document,'$.review.selection.priceLamports')>'18446744073709551615')
 OR julianday(NEW.created_at) IS NULL
 OR julianday(json_extract(NEW.document,'$.sourceObservedAt')) IS NULL
 OR julianday(json_extract(NEW.document,'$.review.reviewedAt')) IS NULL
 OR julianday(json_extract(NEW.document,'$.review.reviewExpiresAt')) IS NULL
 OR abs((julianday(json_extract(NEW.document,'$.review.reviewExpiresAt'))-julianday(json_extract(NEW.document,'$.review.reviewedAt')))*86400-180)>0.001
 OR julianday(json_extract(NEW.document,'$.sourceObservedAt'))<julianday(json_extract(NEW.document,'$.review.reviewedAt'))
 OR julianday(json_extract(NEW.document,'$.sourceObservedAt'))>julianday(NEW.created_at)
 OR julianday(NEW.created_at)>=julianday(json_extract(NEW.document,'$.review.reviewExpiresAt'))
 OR julianday('now')>=julianday(json_extract(NEW.document,'$.review.reviewExpiresAt'))
 OR julianday(NEW.created_at)>julianday('now')+1.0/86400
 THEN RAISE(ABORT,'Invalid unpublished marketplace draft') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM workspace_wallets w WHERE w.owner_id=NEW.owner_id AND w.chain='Solana' AND w.archived=0 AND w.address=NEW.wallet_address AND w.revision=NEW.wallet_revision AND w.label=json_extract(NEW.document,'$.review.evidence.label') AND w.updated_at=json_extract(NEW.document,'$.review.evidence.updatedAt'))
 THEN RAISE(ABORT,'Marketplace draft wallet changed') END;
END;
