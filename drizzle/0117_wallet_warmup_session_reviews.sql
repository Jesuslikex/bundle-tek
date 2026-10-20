CREATE TABLE wallet_warmup_session_reviews (
 owner_id TEXT NOT NULL,
 id TEXT NOT NULL,
 plan_id TEXT NOT NULL,
 plan_revision INTEGER NOT NULL,
 review_sha256 TEXT NOT NULL,
 source_sha256 TEXT NOT NULL,
 document TEXT NOT NULL CHECK(json_valid(document)),
 source TEXT NOT NULL CHECK(json_valid(source)),
 reviewed_at TEXT NOT NULL,
 review_expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,id),
 UNIQUE(owner_id,review_sha256),
 FOREIGN KEY(owner_id,plan_id) REFERENCES wallet_warmup_plans(owner_id,id)
);
--> statement-breakpoint
CREATE INDEX wallet_warmup_session_reviews_plan ON wallet_warmup_session_reviews(owner_id,plan_id,created_at,id);
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_reviews_insert BEFORE INSERT ON wallet_warmup_session_reviews BEGIN
 SELECT CASE WHEN length(NEW.owner_id) NOT BETWEEN 1 AND 256
 OR length(NEW.id)!=36 OR NEW.id GLOB '*[^a-f0-9-]*'
 OR length(replace(NEW.id,'-',''))!=32
 OR substr(NEW.id,9,1)!='-' OR substr(NEW.id,14,1)!='-' OR substr(NEW.id,19,1)!='-' OR substr(NEW.id,24,1)!='-'
 OR typeof(NEW.plan_revision)!='integer' OR NEW.plan_revision NOT BETWEEN 1 AND 999999999
 OR length(NEW.review_sha256)!=64 OR NEW.review_sha256 GLOB '*[^a-f0-9]*'
 OR length(NEW.source_sha256)!=64 OR NEW.source_sha256 GLOB '*[^a-f0-9]*'
 OR length(CAST(NEW.document AS BLOB))>1048576 OR length(CAST(NEW.source AS BLOB))>1048576
 OR length(CAST(NEW.document AS BLOB))+length(CAST(NEW.source AS BLOB))>1572864
 OR julianday(NEW.reviewed_at) IS NULL OR julianday(NEW.review_expires_at) IS NULL OR julianday(NEW.created_at) IS NULL
 OR abs((julianday(NEW.review_expires_at)-julianday(NEW.reviewed_at))*86400-60)>0.001
 OR julianday(NEW.created_at)<julianday(NEW.reviewed_at) OR julianday(NEW.created_at)>julianday(NEW.review_expires_at)
 OR julianday('now')>julianday(NEW.review_expires_at)
 OR json_extract(NEW.document,'$.format') IS NOT 'wallet-warmup-session-review-v1'
 OR json_extract(NEW.document,'$.contextSha256') IS NOT NEW.review_sha256
 OR json_extract(NEW.document,'$.sourceSha256') IS NOT NEW.source_sha256
 OR json_extract(NEW.document,'$.planId') IS NOT NEW.plan_id
 OR json_extract(NEW.document,'$.planRevision') IS NOT NEW.plan_revision
 OR json_extract(NEW.document,'$.reviewedAt') IS NOT NEW.reviewed_at
 OR julianday(json_extract(NEW.document,'$.effectiveStartAt')) IS NULL
 OR json_type(NEW.document,'$.status') IS NOT 'text' OR json_extract(NEW.document,'$.status') NOT IN ('Review required','Recorded loops complete')
 OR json_type(NEW.document,'$.contextKey') IS NOT NULL
 OR json_type(NEW.document,'$.executionAllowed') IS NOT 'false'
 OR json_type(NEW.document,'$.signingAllowed') IS NOT 'false'
 OR json_type(NEW.document,'$.automaticExecutionAllowed') IS NOT 'false'
 OR json_type(NEW.document,'$.wallets') IS NOT 'array' OR json_array_length(NEW.document,'$.wallets') NOT BETWEEN 1 AND 20
 OR json_type(NEW.document,'$.actions') IS NOT 'array' OR json_array_length(NEW.document,'$.actions')>4800
 OR (SELECT count(DISTINCT json_extract(value,'$.wallet')) FROM json_each(NEW.document,'$.wallets'))!=json_array_length(NEW.document,'$.wallets')
 OR (SELECT count(DISTINCT json_extract(value,'$.id')) FROM json_each(NEW.document,'$.actions'))!=json_array_length(NEW.document,'$.actions')
 OR json_extract(NEW.source,'$.format') IS NOT 'wallet-warmup-session-source-v1'
 OR json_type(NEW.source,'$.planDocument') IS NOT 'text' OR NOT json_valid(json_extract(NEW.source,'$.planDocument'))
 OR json_type(NEW.source,'$.buys') IS NOT 'array' OR json_array_length(NEW.source,'$.buys')>4000
 OR json_type(NEW.source,'$.sells') IS NOT 'array' OR json_array_length(NEW.source,'$.sells')>4000
 OR EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND (r.id=NEW.id OR r.review_sha256=NEW.review_sha256))
 OR (SELECT count(DISTINCT json_extract(value,'$.id')) FROM json_each(NEW.source,'$.buys'))!=json_array_length(NEW.source,'$.buys')
 OR (SELECT count(DISTINCT json_extract(value,'$.id')) FROM json_each(NEW.source,'$.sells'))!=json_array_length(NEW.source,'$.sells')
 THEN RAISE(ABORT,'Invalid warmup session review') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_plans p WHERE p.owner_id=NEW.owner_id AND p.id=NEW.plan_id AND p.revision=NEW.plan_revision AND p.archived=0 AND p.document=json_extract(NEW.source,'$.planDocument') AND p.updated_at=json_extract(NEW.source,'$.planUpdatedAt') AND json_extract(p.document,'$.chain')='Solana')
 OR json_array_length(NEW.document,'$.wallets')!=json_array_length(json_extract(NEW.source,'$.planDocument'),'$.addresses')
 OR EXISTS(SELECT 1 FROM json_each(NEW.document,'$.wallets') j WHERE json_type(j.value,'$.wallet') IS NOT 'text' OR json_type(j.value,'$.walletRevision') IS NOT 'integer' OR json_extract(j.value,'$.walletRevision')<1 OR NOT EXISTS(SELECT 1 FROM json_each(json_extract(NEW.source,'$.planDocument'),'$.addresses') a WHERE a.value=json_extract(j.value,'$.wallet')) OR NOT EXISTS(SELECT 1 FROM workspace_wallets w,json_each(json_extract(NEW.source,'$.planDocument'),'$.walletRevisions') c WHERE w.owner_id=NEW.owner_id AND w.chain='Solana' AND w.archived=0 AND w.address=json_extract(j.value,'$.wallet') AND w.revision=json_extract(j.value,'$.walletRevision') AND w.address=json_extract(c.value,'$.address') AND w.revision=json_extract(c.value,'$.revision')))
 THEN RAISE(ABORT,'Warmup session plan or wallets changed') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.document,'$.wallets') j JOIN solana_swap_reservations r ON r.owner_id=NEW.owner_id AND r.wallet_address=json_extract(j.value,'$.wallet'))
 OR EXISTS(SELECT 1 FROM json_each(NEW.document,'$.wallets') j JOIN solana_execution_reservations r ON r.owner_id=NEW.owner_id AND r.wallet_address=json_extract(j.value,'$.wallet'))
 THEN RAISE(ABORT,'Warmup session wallet needs recovery') END;
 SELECT CASE WHEN (SELECT count(*) FROM warmup_buy_receipts r WHERE r.owner_id=NEW.owner_id AND r.plan_id=NEW.plan_id)!=json_array_length(NEW.source,'$.buys')
 OR EXISTS(SELECT 1 FROM json_each(NEW.source,'$.buys') j WHERE NOT EXISTS(SELECT 1 FROM warmup_buy_receipts r WHERE r.owner_id=NEW.owner_id AND r.plan_id=NEW.plan_id AND r.id=json_extract(j.value,'$.id') AND r.plan_revision=json_extract(j.value,'$.planRevision') AND r.wallet_revision=json_extract(j.value,'$.walletRevision') AND r.cycle=json_extract(j.value,'$.cycle') AND r.wallet_address=json_extract(j.value,'$.wallet') AND r.document=json_extract(j.value,'$.document') AND COALESCE(r.remaining_raw,json_extract(r.document,'$.acquiredRaw'))=json_extract(j.value,'$.remainingRaw') AND json_extract(r.document,'$.wallet')=r.wallet_address AND json_extract(r.document,'$.signature')=r.signature AND json_extract(r.document,'$.signatureVerified')=1 AND json_extract(r.document,'$.network')='mainnet' AND json_extract(r.document,'$.commitment')='finalized'))
 OR (SELECT count(*) FROM warmup_sell_receipts r WHERE r.owner_id=NEW.owner_id AND r.plan_id=NEW.plan_id)!=json_array_length(NEW.source,'$.sells')
 OR EXISTS(SELECT 1 FROM json_each(NEW.source,'$.sells') j WHERE NOT EXISTS(SELECT 1 FROM warmup_sell_receipts r WHERE r.owner_id=NEW.owner_id AND r.plan_id=NEW.plan_id AND r.id=json_extract(j.value,'$.id') AND r.buy_receipt_id=json_extract(j.value,'$.buyId') AND r.consumed_raw=json_extract(j.value,'$.consumedRaw') AND r.document=json_extract(j.value,'$.document') AND json_extract(r.document,'$.signature')=r.signature AND json_extract(r.document,'$.signatureVerified')=1 AND json_extract(r.document,'$.buyReceiptId')=r.buy_receipt_id AND json_extract(r.document,'$.consumedRaw')=r.consumed_raw AND json_extract(r.document,'$.network')='mainnet' AND json_extract(r.document,'$.commitment')='finalized'))
 THEN RAISE(ABORT,'Warmup session receipt baseline changed') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.document,'$.actions') a WHERE json_type(a.value,'$.id') IS NOT 'text' OR length(json_extract(a.value,'$.id')) NOT BETWEEN 1 AND 256 OR json_type(a.value,'$.cycle') IS NOT 'integer' OR json_extract(a.value,'$.cycle') NOT BETWEEN 1 AND 20 OR json_type(a.value,'$.side') IS NOT 'text' OR json_extract(a.value,'$.side') NOT IN ('Buy','Sell') OR json_type(a.value,'$.mint') IS NOT 'text' OR julianday(json_extract(a.value,'$.scheduledAt')) IS NULL OR julianday(json_extract(a.value,'$.scheduledAt'))<julianday(json_extract(NEW.document,'$.effectiveStartAt')) OR NOT EXISTS(SELECT 1 FROM json_each(NEW.document,'$.wallets') w WHERE json_extract(w.value,'$.wallet')=json_extract(a.value,'$.wallet') AND json_type(w.value,'$.walletRevision')='integer' AND json_extract(w.value,'$.walletRevision')=json_extract(a.value,'$.walletRevision')))
 THEN RAISE(ABORT,'Invalid warmup session action scope') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.document,'$.actions') a WHERE json_extract(a.value,'$.side')='Sell' AND (json_type(a.value,'$.source.kind') IS NOT 'text' OR json_extract(a.value,'$.source.kind') NOT IN ('session-buy','saved-buy') OR (json_extract(a.value,'$.source.kind')='session-buy' AND NOT EXISTS(SELECT 1 FROM json_each(NEW.document,'$.actions') b WHERE json_extract(b.value,'$.id')=json_extract(a.value,'$.source.actionId') AND json_extract(b.value,'$.side')='Buy' AND json_extract(b.value,'$.wallet')=json_extract(a.value,'$.wallet') AND json_extract(b.value,'$.cycle')=json_extract(a.value,'$.cycle') AND json_extract(b.value,'$.mint')=json_extract(a.value,'$.mint'))) OR (json_extract(a.value,'$.source.kind')='saved-buy' AND NOT EXISTS(SELECT 1 FROM json_each(NEW.source,'$.buys') b WHERE json_extract(b.value,'$.id')=json_extract(a.value,'$.source.buyReceiptId') AND json_extract(b.value,'$.wallet')=json_extract(a.value,'$.wallet') AND json_extract(b.value,'$.cycle')=json_extract(a.value,'$.cycle') AND json_extract(b.value,'$.mint')=json_extract(a.value,'$.mint') AND json_extract(b.value,'$.remainingRaw')=json_extract(a.value,'$.source.remainingRaw') AND json_extract(b.value,'$.decimals')=json_extract(a.value,'$.source.decimals') AND json_extract(b.value,'$.remainingRaw')!='0'))))
 THEN RAISE(ABORT,'Invalid warmup session sell dependency') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_reviews_no_update BEFORE UPDATE ON wallet_warmup_session_reviews BEGIN SELECT RAISE(ABORT,'Warmup session reviews are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_reviews_no_delete BEFORE DELETE ON wallet_warmup_session_reviews BEGIN SELECT RAISE(ABORT,'Warmup session reviews are immutable'); END;
