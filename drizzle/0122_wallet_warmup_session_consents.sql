CREATE TABLE wallet_warmup_session_consents (
 owner_id TEXT NOT NULL,
 id TEXT NOT NULL,
 review_id TEXT NOT NULL,
 terms_sha256 TEXT NOT NULL,
 document TEXT NOT NULL CHECK(json_valid(document)),
 created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,id),
 UNIQUE(owner_id,review_id),
 FOREIGN KEY(owner_id,review_id) REFERENCES wallet_warmup_session_reviews(owner_id,id)
);
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_consents_insert BEFORE INSERT ON wallet_warmup_session_consents BEGIN
 SELECT CASE WHEN length(NEW.owner_id) NOT BETWEEN 1 AND 128
 OR length(NEW.id)!=36 OR NEW.id GLOB '*[^a-f0-9-]*' OR length(replace(NEW.id,'-',''))!=32
 OR substr(NEW.id,9,1)!='-' OR substr(NEW.id,14,1)!='-' OR substr(NEW.id,19,1)!='-' OR substr(NEW.id,24,1)!='-'
 OR length(NEW.terms_sha256)!=64 OR NEW.terms_sha256 GLOB '*[^a-f0-9]*'
 OR length(CAST(NEW.document AS BLOB))>1572864
 OR json_extract(NEW.document,'$.format') IS NOT 'wallet-warmup-session-consent-v1'
 OR json_extract(NEW.document,'$.reviewId') IS NOT NEW.review_id
 OR json_type(NEW.document,'$.executionAllowed') IS NOT 'false'
 OR json_type(NEW.document,'$.signingAllowed') IS NOT 'false'
 OR json_type(NEW.document,'$.automaticExecutionAllowed') IS NOT 'false'
 OR (SELECT count(*) FROM json_each(NEW.document))!=8
 OR julianday(NEW.created_at) IS NULL
 OR json_type(NEW.document,'$.sessionExpiresAt') IS NOT 'text'
 OR julianday(json_extract(NEW.document,'$.sessionExpiresAt')) IS NULL
 OR EXISTS(SELECT 1 FROM wallet_warmup_session_consents c WHERE c.owner_id=NEW.owner_id AND (c.id=NEW.id OR c.review_id=NEW.review_id))
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id
 AND json_extract(NEW.document,'$.reviewSha256') IS r.review_sha256
 AND json_type(NEW.document,'$.reviewDocument')='text' AND json_extract(NEW.document,'$.reviewDocument') IS r.document
 AND json_array_length(r.document,'$.actions')>0
 AND julianday(NEW.created_at)>=julianday(r.reviewed_at) AND julianday(NEW.created_at)<julianday(r.review_expires_at)
 AND julianday('now')<julianday(r.review_expires_at)
 AND julianday(json_extract(NEW.document,'$.sessionExpiresAt'))>julianday(NEW.created_at)
 AND NOT EXISTS(SELECT 1 FROM json_each(r.document,'$.actions') a WHERE julianday(json_extract(a.value,'$.scheduledAt'))>=julianday(json_extract(NEW.document,'$.sessionExpiresAt'))))
 THEN RAISE(ABORT,'Invalid warmup session consent') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_plans p WHERE p.owner_id=NEW.owner_id AND p.id=(SELECT plan_id FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=NEW.review_id) AND p.revision=(SELECT plan_revision FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=NEW.review_id) AND p.archived=0 AND p.document=json_extract((SELECT source FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=NEW.review_id),'$.planDocument') AND p.updated_at=json_extract((SELECT source FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=NEW.review_id),'$.planUpdatedAt') AND json_extract(p.document,'$.chain')='Solana')
 OR json_array_length((SELECT document FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=NEW.review_id),'$.wallets')!=json_array_length(json_extract((SELECT source FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=NEW.review_id),'$.planDocument'),'$.addresses')
 OR EXISTS(SELECT 1 FROM json_each((SELECT document FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=NEW.review_id),'$.wallets') j WHERE json_type(j.value,'$.wallet') IS NOT 'text' OR json_type(j.value,'$.walletRevision') IS NOT 'integer' OR json_extract(j.value,'$.walletRevision')<1 OR NOT EXISTS(SELECT 1 FROM json_each(json_extract((SELECT source FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=NEW.review_id),'$.planDocument'),'$.addresses') a WHERE a.value=json_extract(j.value,'$.wallet')) OR NOT EXISTS(SELECT 1 FROM workspace_wallets w,json_each(json_extract((SELECT source FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=NEW.review_id),'$.planDocument'),'$.walletRevisions') c WHERE w.owner_id=NEW.owner_id AND w.chain='Solana' AND w.archived=0 AND w.address=json_extract(j.value,'$.wallet') AND w.revision=json_extract(j.value,'$.walletRevision') AND w.address=json_extract(c.value,'$.address') AND w.revision=json_extract(c.value,'$.revision')))
 THEN RAISE(ABORT,'Warmup session plan or wallets changed') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each((SELECT document FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=NEW.review_id),'$.wallets') j JOIN solana_swap_reservations r ON r.owner_id=NEW.owner_id AND r.wallet_address=json_extract(j.value,'$.wallet'))
 OR EXISTS(SELECT 1 FROM json_each((SELECT document FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=NEW.review_id),'$.wallets') j JOIN solana_execution_reservations r ON r.owner_id=NEW.owner_id AND r.wallet_address=json_extract(j.value,'$.wallet'))
 THEN RAISE(ABORT,'Warmup session wallet needs recovery') END;
 SELECT CASE WHEN (SELECT count(*) FROM warmup_buy_receipts r WHERE r.owner_id=NEW.owner_id AND r.plan_id=(SELECT plan_id FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=NEW.review_id))!=json_array_length((SELECT source FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=NEW.review_id),'$.buys')
 OR EXISTS(SELECT 1 FROM json_each((SELECT source FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=NEW.review_id),'$.buys') j WHERE NOT EXISTS(SELECT 1 FROM warmup_buy_receipts r WHERE r.owner_id=NEW.owner_id AND r.plan_id=(SELECT plan_id FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=NEW.review_id) AND r.id=json_extract(j.value,'$.id') AND r.plan_revision=json_extract(j.value,'$.planRevision') AND r.wallet_revision=json_extract(j.value,'$.walletRevision') AND r.cycle=json_extract(j.value,'$.cycle') AND r.wallet_address=json_extract(j.value,'$.wallet') AND r.document=json_extract(j.value,'$.document') AND COALESCE(r.remaining_raw,json_extract(r.document,'$.acquiredRaw'))=json_extract(j.value,'$.remainingRaw') AND json_extract(r.document,'$.wallet')=r.wallet_address AND json_extract(r.document,'$.signature')=r.signature AND json_extract(r.document,'$.signatureVerified')=1 AND json_extract(r.document,'$.network')='mainnet' AND json_extract(r.document,'$.commitment')='finalized'))
 OR (SELECT count(*) FROM warmup_sell_receipts r WHERE r.owner_id=NEW.owner_id AND r.plan_id=(SELECT plan_id FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=NEW.review_id))!=json_array_length((SELECT source FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=NEW.review_id),'$.sells')
 OR EXISTS(SELECT 1 FROM json_each((SELECT source FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=NEW.review_id),'$.sells') j WHERE NOT EXISTS(SELECT 1 FROM warmup_sell_receipts r WHERE r.owner_id=NEW.owner_id AND r.plan_id=(SELECT plan_id FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=NEW.review_id) AND r.id=json_extract(j.value,'$.id') AND r.buy_receipt_id=json_extract(j.value,'$.buyId') AND r.consumed_raw=json_extract(j.value,'$.consumedRaw') AND r.document=json_extract(j.value,'$.document') AND json_extract(r.document,'$.signature')=r.signature AND json_extract(r.document,'$.signatureVerified')=1 AND json_extract(r.document,'$.buyReceiptId')=r.buy_receipt_id AND json_extract(r.document,'$.consumedRaw')=r.consumed_raw AND json_extract(r.document,'$.network')='mainnet' AND json_extract(r.document,'$.commitment')='finalized'))
 THEN RAISE(ABORT,'Warmup session receipt baseline changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_consents_no_update BEFORE UPDATE ON wallet_warmup_session_consents BEGIN SELECT RAISE(ABORT,'Warmup session consents are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_consents_no_delete BEFORE DELETE ON wallet_warmup_session_consents BEGIN SELECT RAISE(ABORT,'Warmup session consents are immutable'); END;
