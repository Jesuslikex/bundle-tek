CREATE VIEW wallet_warmup_session_v2_attempt_context AS
SELECT j.owner_id,j.id AS journal_id,h.version,h.head_sha256,h.updated_at AS head_updated_at,c.terms_sha256,
 r.document AS review_document,r.source AS source_document,p.id AS plan_id,p.revision AS plan_revision,p.updated_at AS plan_updated_at,p.document AS plan_document,
 json_extract(c.document,'$.sessionExpiresAt') AS finish_at,json_extract(r.document,'$.actions[0]') AS action_document,
 json_extract(r.document,'$.actions[0].id') AS action_id,json_extract(r.document,'$.actions[0].wallet') AS wallet_address,
 json_extract(c.document,'$.policy.maxQualifications') AS max_attempts
FROM wallet_warmup_session_journals_v2 j
JOIN wallet_warmup_session_journal_heads_v2 h ON h.owner_id=j.owner_id AND h.journal_id=j.id
JOIN wallet_warmup_session_consents_v2 c ON c.owner_id=j.owner_id AND c.id=j.consent_id
JOIN wallet_warmup_session_reviews r ON r.owner_id=j.owner_id AND r.id=j.review_id
JOIN wallet_warmup_plans p ON p.owner_id=j.owner_id AND p.id=r.plan_id AND p.revision=r.plan_revision
WHERE p.archived=0 AND p.document=json_extract(r.source,'$.planDocument') AND p.updated_at=json_extract(r.source,'$.planUpdatedAt')
 AND json_extract(p.document,'$.chain')='Solana' AND json_extract(c.document,'$.reviewDocument')=r.document
 AND json_extract(c.document,'$.policy.qualificationTtlMs')=60000 AND json_extract(c.document,'$.policy.minimumGapMs')=30000
 AND json_extract(c.document,'$.policy.maxAttemptsPerAction')=3 AND json_extract(c.document,'$.policy.maxPendingActions')=1
 AND json_extract(c.document,'$.policy.maxQualifications')=3*json_array_length(r.document,'$.actions')
 AND julianday('now')<julianday(json_extract(c.document,'$.sessionExpiresAt'))
 AND julianday(json_extract(r.document,'$.actions[0].scheduledAt'))<=julianday('now')
 AND EXISTS(SELECT 1 FROM wallet_warmup_session_journal_events_v2 e WHERE e.owner_id=j.owner_id AND e.journal_id=j.id AND json_extract(e.document,'$.operation')='begin-review' AND json_extract(e.document,'$.actionId')=json_extract(r.document,'$.actions[0].id'))
 AND NOT EXISTS(SELECT 1 FROM wallet_warmup_session_journal_events_v2 e WHERE e.owner_id=j.owner_id AND e.journal_id=j.id AND json_extract(e.document,'$.operation')='stop')
 AND COALESCE((SELECT json_extract(e.document,'$.operation') FROM wallet_warmup_session_journal_events_v2 e WHERE e.owner_id=j.owner_id AND e.journal_id=j.id AND json_extract(e.document,'$.operation') IN ('pause','resume') ORDER BY e.version DESC LIMIT 1),'resume')='resume'
 AND (json_extract(r.document,'$.actions[0].side')='Buy' OR json_extract(r.document,'$.actions[0].source.kind')='saved-buy')
 AND (json_extract(r.document,'$.actions[0].side')='Buy' OR EXISTS(SELECT 1 FROM warmup_buy_receipts b WHERE b.owner_id=j.owner_id AND b.plan_id=p.id AND b.id=json_extract(r.document,'$.actions[0].source.buyReceiptId') AND b.remaining_raw IS NOT NULL AND b.remaining_raw=json_extract(r.document,'$.actions[0].source.remainingRaw') AND json_extract(b.document,'$.decimals')=json_extract(r.document,'$.actions[0].source.decimals')))
 AND json_array_length(r.document,'$.wallets')=json_array_length(p.document,'$.addresses')
 AND NOT EXISTS(SELECT 1 FROM json_each(r.document,'$.wallets') w WHERE
  NOT EXISTS(SELECT 1 FROM json_each(p.document,'$.addresses') a WHERE a.value=json_extract(w.value,'$.wallet'))
  OR NOT EXISTS(SELECT 1 FROM workspace_wallets active,json_each(p.document,'$.walletRevisions') captured WHERE active.owner_id=j.owner_id AND active.chain='Solana' AND active.archived=0 AND active.address=json_extract(w.value,'$.wallet') AND active.revision=json_extract(w.value,'$.walletRevision') AND active.address=json_extract(captured.value,'$.address') AND active.revision=json_extract(captured.value,'$.revision'))
  OR EXISTS(SELECT 1 FROM solana_swap_reservations hold WHERE hold.owner_id=j.owner_id AND hold.wallet_address=json_extract(w.value,'$.wallet'))
  OR EXISTS(SELECT 1 FROM solana_execution_reservations hold WHERE hold.owner_id=j.owner_id AND hold.wallet_address=json_extract(w.value,'$.wallet')))
 AND (SELECT count(*) FROM warmup_buy_receipts b WHERE b.owner_id=j.owner_id AND b.plan_id=p.id)=json_array_length(r.source,'$.buys')
 AND NOT EXISTS(SELECT 1 FROM json_each(r.source,'$.buys') original WHERE NOT EXISTS(SELECT 1 FROM warmup_buy_receipts b WHERE b.owner_id=j.owner_id AND b.plan_id=p.id
  AND b.id=json_extract(original.value,'$.id') AND b.plan_revision=json_extract(original.value,'$.planRevision') AND b.wallet_revision=json_extract(original.value,'$.walletRevision')
  AND b.cycle=json_extract(original.value,'$.cycle') AND b.wallet_address=json_extract(original.value,'$.wallet') AND b.document=json_extract(original.value,'$.document')
  AND COALESCE(b.remaining_raw,json_extract(b.document,'$.acquiredRaw'))=json_extract(original.value,'$.remainingRaw')
  AND json_extract(b.document,'$.wallet')=b.wallet_address AND json_extract(b.document,'$.signature')=b.signature AND json_extract(b.document,'$.signatureVerified')=1 AND json_extract(b.document,'$.network')='mainnet' AND json_extract(b.document,'$.commitment')='finalized'))
 AND (SELECT count(*) FROM warmup_sell_receipts s WHERE s.owner_id=j.owner_id AND s.plan_id=p.id)=json_array_length(r.source,'$.sells')
 AND NOT EXISTS(SELECT 1 FROM json_each(r.source,'$.sells') original WHERE NOT EXISTS(SELECT 1 FROM warmup_sell_receipts s WHERE s.owner_id=j.owner_id AND s.plan_id=p.id
  AND s.id=json_extract(original.value,'$.id') AND s.buy_receipt_id=json_extract(original.value,'$.buyId') AND s.consumed_raw=json_extract(original.value,'$.consumedRaw') AND s.document=json_extract(original.value,'$.document')
  AND json_extract(s.document,'$.signature')=s.signature AND json_extract(s.document,'$.signatureVerified')=1 AND json_extract(s.document,'$.buyReceiptId')=s.buy_receipt_id AND json_extract(s.document,'$.consumedRaw')=s.consumed_raw AND json_extract(s.document,'$.network')='mainnet' AND json_extract(s.document,'$.commitment')='finalized'));
--> statement-breakpoint
CREATE TABLE wallet_warmup_session_v2_attempts (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,journal_id TEXT NOT NULL,action_id TEXT NOT NULL,
 sequence INTEGER NOT NULL,attempt_no INTEGER NOT NULL,previous_id TEXT,
 review_version INTEGER NOT NULL,review_sha256 TEXT NOT NULL,terms_sha256 TEXT NOT NULL,
 created_at TEXT NOT NULL,expires_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,id),
 FOREIGN KEY(owner_id,journal_id) REFERENCES wallet_warmup_session_journals_v2(owner_id,id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX warmup_v2_attempt_sequence ON wallet_warmup_session_v2_attempts(owner_id,journal_id,sequence);
--> statement-breakpoint
CREATE UNIQUE INDEX warmup_v2_attempt_identity ON wallet_warmup_session_v2_attempts(id);
--> statement-breakpoint
CREATE UNIQUE INDEX warmup_v2_attempt_action_number ON wallet_warmup_session_v2_attempts(owner_id,journal_id,action_id,attempt_no);
--> statement-breakpoint
CREATE TABLE wallet_warmup_session_v2_attempt_outcomes (
 owner_id TEXT NOT NULL,attempt_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('prepared','refused')),
 summary_document TEXT,unsigned_transaction TEXT,packet_sha256 TEXT,fee_document TEXT,refusal_code TEXT,
 created_at TEXT NOT NULL,expires_at TEXT NOT NULL,record_sha256 TEXT NOT NULL,
 PRIMARY KEY(owner_id,attempt_id),
 FOREIGN KEY(owner_id,attempt_id) REFERENCES wallet_warmup_session_v2_attempts(owner_id,id),
 CHECK((kind='prepared' AND typeof(summary_document)='text' AND json_valid(summary_document) AND length(CAST(summary_document AS BLOB))<=8192 AND typeof(unsigned_transaction)='text' AND length(unsigned_transaction) BETWEEN 1 AND 1644 AND typeof(packet_sha256)='text' AND typeof(fee_document)='text' AND json_valid(fee_document) AND length(CAST(fee_document AS BLOB))<=512 AND refusal_code IS NULL)
 OR (kind='refused' AND summary_document IS NULL AND unsigned_transaction IS NULL AND packet_sha256 IS NULL AND fee_document IS NULL AND refusal_code IN ('provider-refused','provider-limited','provider-unavailable','evidence-refused')))
);
--> statement-breakpoint
CREATE UNIQUE INDEX warmup_v2_attempt_packet ON wallet_warmup_session_v2_attempt_outcomes(owner_id,packet_sha256);
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_v2_attempts_insert BEFORE INSERT ON wallet_warmup_session_v2_attempts BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM wallet_warmup_session_v2_attempts a WHERE a.id=NEW.id)
 OR typeof(NEW.id)!='text' OR length(NEW.id)!=36 OR NEW.id GLOB '*[^a-f0-9-]*' OR length(replace(NEW.id,'-',''))!=32
 OR substr(NEW.id,9,1)!='-' OR substr(NEW.id,14,1)!='-' OR substr(NEW.id,19,1)!='-' OR substr(NEW.id,24,1)!='-'
 OR length(CAST(NEW.owner_id AS BLOB)) NOT BETWEEN 1 AND 128 OR length(CAST(NEW.action_id AS BLOB)) NOT BETWEEN 1 AND 256
 OR typeof(NEW.sequence)!='integer' OR NEW.sequence NOT BETWEEN 1 AND 14400 OR typeof(NEW.attempt_no)!='integer' OR NEW.attempt_no NOT BETWEEN 1 AND 3
 OR typeof(NEW.review_version)!='integer' OR NEW.review_version NOT BETWEEN 1 AND 65535
 OR NEW.created_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_session_v2_attempt_context c WHERE c.owner_id=NEW.owner_id AND c.journal_id=NEW.journal_id AND c.version=NEW.review_version AND c.head_sha256=NEW.review_sha256 AND c.terms_sha256=NEW.terms_sha256 AND c.action_id=NEW.action_id
  AND NEW.expires_at=min(strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds'),c.finish_at) AND NEW.expires_at>NEW.created_at
  AND NEW.created_at>=c.head_updated_at AND NEW.sequence<=c.max_attempts)
 OR NEW.sequence!=(SELECT count(*)+1 FROM wallet_warmup_session_v2_attempts a WHERE a.owner_id=NEW.owner_id AND a.journal_id=NEW.journal_id)
 OR NEW.attempt_no!=(SELECT count(*)+1 FROM wallet_warmup_session_v2_attempts a WHERE a.owner_id=NEW.owner_id AND a.journal_id=NEW.journal_id AND a.action_id=NEW.action_id)
 OR NEW.previous_id IS NOT (SELECT id FROM wallet_warmup_session_v2_attempts a WHERE a.owner_id=NEW.owner_id AND a.journal_id=NEW.journal_id ORDER BY sequence DESC LIMIT 1)
 OR EXISTS(SELECT 1 FROM wallet_warmup_session_v2_attempts a LEFT JOIN wallet_warmup_session_v2_attempt_outcomes o ON o.owner_id=a.owner_id AND o.attempt_id=a.id WHERE a.owner_id=NEW.owner_id AND a.journal_id=NEW.journal_id
  AND (julianday(NEW.created_at)<julianday(a.created_at,'+30 seconds') OR (COALESCE(o.kind,'pending')!='refused' AND NEW.created_at<COALESCE(o.expires_at,a.expires_at))))
 OR EXISTS(SELECT 1 FROM wallet_balance_gates g WHERE g.owner_id=NEW.owner_id AND g.next_allowed_at>CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))
 OR EXISTS(SELECT 1 FROM warmup_swap_preparations WHERE id=NEW.id)
 OR EXISTS(SELECT 1 FROM wallet_warmup_session_preparations WHERE preparation_id=NEW.id)
 OR EXISTS(SELECT 1 FROM warmup_signing_intents WHERE id=NEW.id OR preparation_id=NEW.id)
 OR EXISTS(SELECT 1 FROM warmup_buy_receipts WHERE id=NEW.id OR preparation_id=NEW.id)
 OR EXISTS(SELECT 1 FROM warmup_sell_receipts WHERE id=NEW.id OR preparation_id=NEW.id)
 THEN RAISE(ABORT,'Fresh unsigned warmup attempt is unavailable') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_v2_attempts_gate AFTER INSERT ON wallet_warmup_session_v2_attempts BEGIN
 INSERT INTO wallet_balance_gates(owner_id,next_allowed_at) VALUES(NEW.owner_id,CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER)+30000)
 ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=excluded.next_allowed_at-30000;
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'Warmup provider cooldown changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_v2_attempts_no_update BEFORE UPDATE ON wallet_warmup_session_v2_attempts BEGIN SELECT RAISE(ABORT,'Warmup attempts are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_v2_attempts_no_delete BEFORE DELETE ON wallet_warmup_session_v2_attempts BEGIN SELECT RAISE(ABORT,'Warmup attempts are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_v2_outcomes_insert BEFORE INSERT ON wallet_warmup_session_v2_attempt_outcomes BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM wallet_warmup_session_v2_attempt_outcomes o WHERE o.owner_id=NEW.owner_id AND o.attempt_id=NEW.attempt_id)
 OR EXISTS(SELECT 1 FROM wallet_warmup_session_v2_attempt_outcomes o WHERE o.owner_id=NEW.owner_id AND o.packet_sha256=NEW.packet_sha256)
 OR length(NEW.record_sha256)!=64 OR NEW.record_sha256 GLOB '*[^a-f0-9]*'
 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) IS NOT NEW.created_at
 OR NEW.created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_session_v2_attempts a JOIN wallet_warmup_session_v2_attempt_context c ON c.owner_id=a.owner_id AND c.journal_id=a.journal_id AND c.version=a.review_version AND c.head_sha256=a.review_sha256
 WHERE a.owner_id=NEW.owner_id AND a.id=NEW.attempt_id AND a.action_id=c.action_id AND a.terms_sha256=c.terms_sha256 AND a.created_at<=NEW.created_at
 AND NEW.created_at<a.expires_at AND strftime('%Y-%m-%dT%H:%M:%fZ','now')<a.expires_at
 AND (NEW.kind='refused' AND NEW.expires_at=NEW.created_at OR NEW.kind='prepared' AND NEW.expires_at=min(a.expires_at,json_extract(NEW.summary_document,'$.expiresAt')) AND NEW.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND json_type(NEW.summary_document,'$.executionAllowed') IS 'false' AND json_type(NEW.summary_document,'$.instructionsVerified') IS 'false'
  AND json_extract(NEW.summary_document,'$.wallet')=c.wallet_address AND json_extract(NEW.summary_document,'$.side')=json_extract(c.action_document,'$.side')
  AND json_extract(NEW.summary_document,'$.chain')='Solana' AND json_extract(NEW.summary_document,'$.transaction.sha256')=NEW.packet_sha256
  AND length(NEW.packet_sha256)=64 AND NEW.packet_sha256 NOT GLOB '*[^a-f0-9]*'
  AND json_type(NEW.summary_document,'$.simulation.succeeded') IS 'true' AND json_type(NEW.summary_document,'$.simulation.tokensComplete') IS 'true'
  AND (SELECT count(*) FROM json_each(NEW.fee_document))=5
  AND json_type(NEW.fee_document,'$.signatureFeeLamports') IS 'text' AND json_type(NEW.fee_document,'$.prioritizationFeeLamports') IS 'text' AND json_type(NEW.fee_document,'$.rentFeeLamports') IS 'text' AND json_type(NEW.fee_document,'$.boundLamports') IS 'text'
  AND json_type(NEW.fee_document,'$.observedNetworkFeeLamports') IS 'text' AND json_extract(NEW.fee_document,'$.observedNetworkFeeLamports')=json_extract(NEW.summary_document,'$.simulation.networkFeeLamports')
  AND ((json_extract(c.action_document,'$.side')='Buy' AND json_extract(NEW.summary_document,'$.inputMint')='So11111111111111111111111111111111111111112' AND json_extract(NEW.summary_document,'$.outputMint')=json_extract(c.action_document,'$.mint') AND json_extract(NEW.summary_document,'$.inAmountRaw')=json_extract(c.action_document,'$.inputLamports') AND json_type(NEW.summary_document,'$.simulation.minimumOutputCovered') IS 'true')
   OR (json_extract(c.action_document,'$.side')='Sell' AND json_extract(NEW.summary_document,'$.inputMint')=json_extract(c.action_document,'$.mint') AND json_extract(NEW.summary_document,'$.outputMint')='So11111111111111111111111111111111111111112' AND json_extract(NEW.summary_document,'$.inAmountRaw')=json_extract(c.action_document,'$.source.remainingRaw') AND json_extract(NEW.summary_document,'$.buyReceipt.receiptId')=json_extract(c.action_document,'$.source.buyReceiptId') AND json_type(NEW.summary_document,'$.simulation.inputAmountMatches') IS 'true'))))
 THEN RAISE(ABORT,'Fresh unsigned warmup result expired or changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_v2_outcomes_no_update BEFORE UPDATE ON wallet_warmup_session_v2_attempt_outcomes BEGIN SELECT RAISE(ABORT,'Warmup attempt outcomes are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_v2_outcomes_no_delete BEFORE DELETE ON wallet_warmup_session_v2_attempt_outcomes BEGIN SELECT RAISE(ABORT,'Warmup attempt outcomes are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_v2_attempt_preparation_isolation BEFORE INSERT ON warmup_swap_preparations WHEN EXISTS(SELECT 1 FROM wallet_warmup_session_v2_attempts a WHERE a.id=NEW.id) BEGIN SELECT RAISE(ABORT,'V2 attempts are not manual preparations'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_v2_attempt_legacy_preparation_isolation BEFORE INSERT ON wallet_warmup_session_preparations WHEN EXISTS(SELECT 1 FROM wallet_warmup_session_v2_attempts a WHERE a.id=NEW.preparation_id) BEGIN SELECT RAISE(ABORT,'V2 attempts cannot enter legacy sessions'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_v2_attempt_signing_isolation BEFORE INSERT ON warmup_signing_intents WHEN EXISTS(SELECT 1 FROM wallet_warmup_session_v2_attempts a WHERE a.id=NEW.preparation_id OR a.id=NEW.id) BEGIN SELECT RAISE(ABORT,'V2 attempt signing is not enabled'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_v2_attempt_buy_receipt_isolation BEFORE INSERT ON warmup_buy_receipts WHEN EXISTS(SELECT 1 FROM wallet_warmup_session_v2_attempts a WHERE a.id=NEW.preparation_id OR a.id=NEW.id) BEGIN SELECT RAISE(ABORT,'V2 attempt settlement is not enabled'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_v2_attempt_sell_receipt_isolation BEFORE INSERT ON warmup_sell_receipts WHEN EXISTS(SELECT 1 FROM wallet_warmup_session_v2_attempts a WHERE a.id=NEW.preparation_id OR a.id=NEW.id) BEGIN SELECT RAISE(ABORT,'V2 attempt settlement is not enabled'); END;
