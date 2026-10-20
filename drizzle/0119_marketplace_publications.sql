CREATE TABLE marketplace_publications (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 draft_id TEXT NOT NULL,
 draft_sha256 TEXT NOT NULL,
 wallet_address TEXT NOT NULL,
 context_sha256 TEXT NOT NULL,
 document TEXT NOT NULL CHECK(json_valid(document)),
 published_at TEXT NOT NULL,
 UNIQUE(owner_id,draft_id),
 UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,draft_id) REFERENCES marketplace_operator_drafts(owner_id,id)
);
--> statement-breakpoint
CREATE INDEX marketplace_publications_wallet ON marketplace_publications(wallet_address);
--> statement-breakpoint
CREATE TABLE marketplace_withdrawals (
 owner_id TEXT NOT NULL,
 publication_id TEXT NOT NULL,
 context_sha256 TEXT NOT NULL,
 withdrawn_at TEXT NOT NULL,
 acknowledgement TEXT NOT NULL,
 PRIMARY KEY(owner_id,publication_id),
 FOREIGN KEY(owner_id,publication_id) REFERENCES marketplace_publications(owner_id,id)
);
--> statement-breakpoint
CREATE TRIGGER marketplace_publications_insert BEFORE INSERT ON marketplace_publications BEGIN
 SELECT CASE WHEN length(NEW.id)!=36 OR NEW.id GLOB '*[^a-f0-9-]*' OR length(replace(NEW.id,'-',''))!=32
 OR substr(NEW.id,9,1)!='-' OR substr(NEW.id,14,1)!='-' OR substr(NEW.id,19,1)!='-' OR substr(NEW.id,24,1)!='-'
 OR length(NEW.owner_id) NOT BETWEEN 1 AND 256 OR length(NEW.document)>16384
 OR length(NEW.context_sha256)!=64 OR NEW.context_sha256 GLOB '*[^a-f0-9]*'
 OR json_extract(NEW.document,'$.format') IS NOT 'bundle-publication-v1'
 OR json_extract(NEW.document,'$.id') IS NOT NEW.id
 OR json_extract(NEW.document,'$.publishedAt') IS NOT NEW.published_at
 OR json_type(NEW.document,'$.withdrawnAt') IS NOT 'null'
 OR json_extract(NEW.document,'$.acknowledgement') IS NOT 'Publish this wallet address, asking price and historical evidence to signed-in Bundle customers. This does not authorize purchase, payment, signing or key delivery.'
 OR json_extract(NEW.document,'$.preview.format') IS NOT 'bundle-publication-review-v1'
 OR json_extract(NEW.document,'$.preview.draftId') IS NOT NEW.draft_id
 OR json_extract(NEW.document,'$.preview.draftSha256') IS NOT NEW.draft_sha256
 OR json_extract(NEW.document,'$.preview.contextSha256') IS NOT NEW.context_sha256
 OR json_extract(NEW.document,'$.preview.listing.address') IS NOT NEW.wallet_address
 OR json_type(NEW.document,'$.preview.purchaseEnabled') IS NOT 'false'
 OR json_type(NEW.document,'$.preview.deliveryEnabled') IS NOT 'false'
 OR json_type(NEW.document,'$.preview.signingAllowed') IS NOT 'false'
 OR julianday(NEW.published_at) IS NULL
 OR julianday(json_extract(NEW.document,'$.preview.reviewedAt')) IS NULL
 OR julianday(json_extract(NEW.document,'$.preview.expiresAt')) IS NULL
 OR abs((julianday(json_extract(NEW.document,'$.preview.expiresAt'))-julianday(json_extract(NEW.document,'$.preview.reviewedAt')))*86400-60)>0.001
 OR julianday(NEW.published_at)<julianday(json_extract(NEW.document,'$.preview.reviewedAt'))
 OR julianday(NEW.published_at)>=julianday(json_extract(NEW.document,'$.preview.expiresAt'))
 OR julianday(NEW.published_at)>julianday('now')+1.0/86400
 OR julianday('now')>=julianday(json_extract(NEW.document,'$.preview.expiresAt'))
 OR EXISTS(SELECT 1 FROM marketplace_publications p WHERE p.wallet_address=NEW.wallet_address AND NOT EXISTS(SELECT 1 FROM marketplace_withdrawals w WHERE w.owner_id=p.owner_id AND w.publication_id=p.id))
 THEN RAISE(ABORT,'Invalid or already active marketplace publication') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM marketplace_operator_drafts d JOIN workspace_wallets w ON w.owner_id=d.owner_id AND w.chain='Solana' AND w.address=d.wallet_address WHERE d.owner_id=NEW.owner_id AND d.id=NEW.draft_id AND d.review_sha256=NEW.draft_sha256 AND d.wallet_address=NEW.wallet_address AND w.archived=0 AND w.revision=d.wallet_revision AND w.label=json_extract(d.document,'$.review.evidence.label') AND w.updated_at=json_extract(d.document,'$.review.evidence.updatedAt') AND json_extract(NEW.document,'$.preview.listing.priceLamports') IS json_extract(d.document,'$.review.selection.priceLamports') AND json_extract(NEW.document,'$.preview.listing.disclosure') IS json_extract(d.document,'$.review.disclosure'))
 THEN RAISE(ABORT,'Marketplace publication draft or wallet changed') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_ownership_proofs p JOIN marketplace_operator_drafts d ON d.owner_id=p.owner_id AND d.wallet_address=p.address WHERE d.owner_id=NEW.owner_id AND d.id=NEW.draft_id AND p.chain='Solana' AND p.verified_at=json_extract(d.document,'$.review.evidence.ownershipProofAt'))
 THEN RAISE(ABORT,'Marketplace publication control proof changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER marketplace_publications_no_update BEFORE UPDATE ON marketplace_publications BEGIN
 SELECT RAISE(ABORT,'Marketplace publications are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER marketplace_publications_no_delete BEFORE DELETE ON marketplace_publications BEGIN
 SELECT RAISE(ABORT,'Marketplace publications are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER marketplace_withdrawals_insert BEFORE INSERT ON marketplace_withdrawals BEGIN
 SELECT CASE WHEN NEW.acknowledgement IS NOT 'Withdraw this exact listing from the Bundle catalog. This does not delete its publication history.'
 OR julianday(NEW.withdrawn_at) IS NULL
 OR NOT EXISTS(SELECT 1 FROM marketplace_publications p WHERE p.owner_id=NEW.owner_id AND p.id=NEW.publication_id AND p.context_sha256=NEW.context_sha256 AND julianday(NEW.withdrawn_at)>=julianday(p.published_at))
 THEN RAISE(ABORT,'Invalid marketplace withdrawal') END;
END;
--> statement-breakpoint
CREATE TRIGGER marketplace_withdrawals_no_update BEFORE UPDATE ON marketplace_withdrawals BEGIN
 SELECT RAISE(ABORT,'Marketplace withdrawals are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER marketplace_withdrawals_no_delete BEFORE DELETE ON marketplace_withdrawals BEGIN
 SELECT RAISE(ABORT,'Marketplace withdrawals are immutable');
END;
