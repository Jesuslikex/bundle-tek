CREATE TABLE wallet_warmup_session_journals_v2 (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,consent_id TEXT NOT NULL,review_id TEXT NOT NULL,terms_sha256 TEXT NOT NULL,initial_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,consent_id),
 FOREIGN KEY(owner_id,consent_id) REFERENCES wallet_warmup_session_consents_v2(owner_id,id)
);
--> statement-breakpoint
CREATE TABLE wallet_warmup_session_journal_events_v2 (
 owner_id TEXT NOT NULL,journal_id TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,previous_sha256 TEXT NOT NULL,document TEXT NOT NULL CHECK(json_valid(document)),event_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,journal_id,version),FOREIGN KEY(owner_id,journal_id) REFERENCES wallet_warmup_session_journals_v2(owner_id,id)
);
--> statement-breakpoint
CREATE TABLE wallet_warmup_session_journal_heads_v2 (
 owner_id TEXT NOT NULL,journal_id TEXT NOT NULL,version INTEGER NOT NULL,head_sha256 TEXT NOT NULL,document_bytes INTEGER NOT NULL,updated_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,journal_id),FOREIGN KEY(owner_id,journal_id) REFERENCES wallet_warmup_session_journals_v2(owner_id,id)
);
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_journals_v2_insert BEFORE INSERT ON wallet_warmup_session_journals_v2 BEGIN
 SELECT CASE WHEN length(NEW.owner_id) NOT BETWEEN 1 AND 128
 OR length(NEW.id)!=36 OR NEW.id GLOB '*[^a-f0-9-]*' OR length(replace(NEW.id,'-',''))!=32
 OR substr(NEW.id,9,1)!='-' OR substr(NEW.id,14,1)!='-' OR substr(NEW.id,19,1)!='-' OR substr(NEW.id,24,1)!='-'
 OR length(NEW.initial_sha256)!=64 OR NEW.initial_sha256 GLOB '*[^a-f0-9]*'
 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) IS NOT NEW.created_at
 OR EXISTS(SELECT 1 FROM wallet_warmup_session_journals_v2 j WHERE j.owner_id=NEW.owner_id AND (j.id=NEW.id OR j.consent_id=NEW.consent_id))
 OR EXISTS(SELECT 1 FROM wallet_warmup_session_journals j WHERE j.owner_id=NEW.owner_id AND j.id=NEW.id)
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_session_consents_v2 c WHERE c.owner_id=NEW.owner_id AND c.id=NEW.consent_id AND c.review_id=NEW.review_id AND c.terms_sha256=NEW.terms_sha256 AND c.created_at<=NEW.created_at)
 THEN RAISE(ABORT,'Invalid versioned warmup history root') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_journals_v2_no_update BEFORE UPDATE ON wallet_warmup_session_journals_v2 BEGIN SELECT RAISE(ABORT,'Versioned warmup history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_journals_v2_no_delete BEFORE DELETE ON wallet_warmup_session_journals_v2 BEGIN SELECT RAISE(ABORT,'Versioned warmup history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_journal_events_v2_no_update BEFORE UPDATE ON wallet_warmup_session_journal_events_v2 BEGIN SELECT RAISE(ABORT,'Versioned warmup events are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_journal_events_v2_no_delete BEFORE DELETE ON wallet_warmup_session_journal_events_v2 BEGIN SELECT RAISE(ABORT,'Versioned warmup events are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_journal_heads_v2_insert BEFORE INSERT ON wallet_warmup_session_journal_heads_v2 BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM wallet_warmup_session_journal_heads_v2 WHERE owner_id=NEW.owner_id AND journal_id=NEW.journal_id)
 OR NEW.version!=0 OR NEW.document_bytes!=0 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_session_journals_v2 j WHERE j.owner_id=NEW.owner_id AND j.id=NEW.journal_id AND j.initial_sha256=NEW.head_sha256 AND j.created_at=NEW.updated_at)
 OR EXISTS(SELECT 1 FROM wallet_warmup_session_journal_events_v2 WHERE owner_id=NEW.owner_id AND journal_id=NEW.journal_id)
 THEN RAISE(ABORT,'Invalid versioned warmup head') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_journal_heads_v2_update BEFORE UPDATE ON wallet_warmup_session_journal_heads_v2 BEGIN
 SELECT CASE WHEN NEW.owner_id IS NOT OLD.owner_id OR NEW.journal_id IS NOT OLD.journal_id OR NEW.version!=OLD.version+1
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_session_journal_events_v2 e WHERE e.owner_id=OLD.owner_id AND e.journal_id=OLD.journal_id AND e.version=NEW.version AND e.previous_sha256=OLD.head_sha256 AND e.event_sha256=NEW.head_sha256 AND e.created_at=NEW.updated_at AND NEW.document_bytes=OLD.document_bytes+length(CAST(e.document AS BLOB)))
 THEN RAISE(ABORT,'Versioned warmup head changed without its event') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_journal_heads_v2_no_delete BEFORE DELETE ON wallet_warmup_session_journal_heads_v2 BEGIN SELECT RAISE(ABORT,'Versioned warmup head is retained'); END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_journals_v2_head AFTER INSERT ON wallet_warmup_session_journals_v2 BEGIN
 INSERT INTO wallet_warmup_session_journal_heads_v2 VALUES(NEW.owner_id,NEW.id,0,NEW.initial_sha256,0,NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_journal_events_v2_insert BEFORE INSERT ON wallet_warmup_session_journal_events_v2 BEGIN
 SELECT CASE WHEN length(NEW.id)!=36 OR NEW.id GLOB '*[^a-f0-9-]*' OR length(replace(NEW.id,'-',''))!=32
 OR substr(NEW.id,9,1)!='-' OR substr(NEW.id,14,1)!='-' OR substr(NEW.id,19,1)!='-' OR substr(NEW.id,24,1)!='-'
 OR typeof(NEW.version)!='integer' OR NEW.version NOT BETWEEN 1 AND 65536
 OR length(NEW.event_sha256)!=64 OR NEW.event_sha256 GLOB '*[^a-f0-9]*'
 OR length(CAST(NEW.document AS BLOB))>2048
 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) IS NOT NEW.created_at
 OR json_extract(NEW.document,'$.format') IS NOT 'wallet-warmup-session-event-v2'
 OR json_extract(NEW.document,'$.eventId') IS NOT NEW.id OR json_type(NEW.document,'$.version') IS NOT 'integer' OR json_extract(NEW.document,'$.version') IS NOT NEW.version
 OR json_extract(NEW.document,'$.previousSha256') IS NOT NEW.previous_sha256 OR json_extract(NEW.document,'$.at') IS NOT NEW.created_at
 OR json_type(NEW.document,'$.operation') IS NOT 'text' OR json_extract(NEW.document,'$.operation') NOT IN ('begin-review','pause','resume','stop')
 OR (SELECT count(*) FROM json_each(NEW.document))!= CASE WHEN json_extract(NEW.document,'$.operation')='begin-review' THEN 7 ELSE 6 END
 OR EXISTS(SELECT 1 FROM wallet_warmup_session_journal_events_v2 e WHERE e.owner_id=NEW.owner_id AND (e.id=NEW.id OR (e.journal_id=NEW.journal_id AND (e.version=NEW.version OR json_extract(e.document,'$.operation')='stop'))))
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_session_journal_heads_v2 h WHERE h.owner_id=NEW.owner_id AND h.journal_id=NEW.journal_id AND h.version=NEW.version-1 AND h.head_sha256=NEW.previous_sha256 AND h.updated_at<=NEW.created_at
 AND h.document_bytes+length(CAST(NEW.document AS BLOB))<=33554432
 AND (json_extract(NEW.document,'$.operation')='stop' OR (h.version<65535 AND h.document_bytes+length(CAST(NEW.document AS BLOB))<=33550336)))
 THEN RAISE(ABORT,'Versioned warmup event or head differs') END;
 SELECT CASE WHEN json_extract(NEW.document,'$.operation')='pause' AND COALESCE((SELECT json_extract(e.document,'$.operation') FROM wallet_warmup_session_journal_events_v2 e WHERE e.owner_id=NEW.owner_id AND e.journal_id=NEW.journal_id AND json_extract(e.document,'$.operation') IN ('pause','resume') ORDER BY e.version DESC LIMIT 1),'resume')='pause'
 OR (json_extract(NEW.document,'$.operation')='resume' AND COALESCE((SELECT json_extract(e.document,'$.operation') FROM wallet_warmup_session_journal_events_v2 e WHERE e.owner_id=NEW.owner_id AND e.journal_id=NEW.journal_id AND json_extract(e.document,'$.operation') IN ('pause','resume') ORDER BY e.version DESC LIMIT 1),'resume')!='pause')
 THEN RAISE(ABORT,'Versioned warmup control is redundant') END;
 SELECT CASE WHEN json_extract(NEW.document,'$.operation')!='stop' AND NOT EXISTS(SELECT 1 FROM wallet_warmup_session_journals_v2 j JOIN wallet_warmup_session_consents_v2 c ON c.owner_id=j.owner_id AND c.id=j.consent_id WHERE j.owner_id=NEW.owner_id AND j.id=NEW.journal_id AND NEW.created_at<json_extract(c.document,'$.sessionExpiresAt') AND julianday('now')<julianday(json_extract(c.document,'$.sessionExpiresAt')))
 THEN RAISE(ABORT,'Approved versioned warmup session has finished') END;
 SELECT CASE WHEN json_extract(NEW.document,'$.operation')='begin-review' AND (
 EXISTS(SELECT 1 FROM wallet_warmup_session_journal_events_v2 e WHERE e.owner_id=NEW.owner_id AND e.journal_id=NEW.journal_id AND json_extract(e.document,'$.operation')='begin-review')
 OR COALESCE((SELECT json_extract(e.document,'$.operation') FROM wallet_warmup_session_journal_events_v2 e WHERE e.owner_id=NEW.owner_id AND e.journal_id=NEW.journal_id AND json_extract(e.document,'$.operation') IN ('pause','resume') ORDER BY e.version DESC LIMIT 1),'resume')='pause'
 OR json_type(NEW.document,'$.actionId') IS NOT 'text'
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_session_journals_v2 j JOIN wallet_warmup_session_consents_v2 c ON c.owner_id=j.owner_id AND c.id=j.consent_id WHERE j.owner_id=NEW.owner_id AND j.id=NEW.journal_id AND json_extract(NEW.document,'$.actionId')=json_extract(json_extract(c.document,'$.reviewDocument'),'$.actions[0].id') AND json_extract(json_extract(c.document,'$.reviewDocument'),'$.actions[0].scheduledAt')<=NEW.created_at AND julianday(json_extract(json_extract(c.document,'$.reviewDocument'),'$.actions[0].scheduledAt'))<=julianday('now') AND (json_extract(json_extract(c.document,'$.reviewDocument'),'$.actions[0].side')='Buy' OR json_extract(json_extract(c.document,'$.reviewDocument'),'$.actions[0].source.kind')='saved-buy')))
 THEN RAISE(ABORT,'Versioned warmup review slot is unavailable') END;
  SELECT CASE WHEN json_extract(NEW.document,'$.operation') IN ('begin-review','resume') AND ( NOT EXISTS(SELECT 1 FROM wallet_warmup_plans p WHERE p.owner_id=NEW.owner_id AND p.id=(SELECT plan_id FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=(SELECT review_id FROM wallet_warmup_session_journals_v2 WHERE owner_id=NEW.owner_id AND id=NEW.journal_id)) AND p.revision=(SELECT plan_revision FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=(SELECT review_id FROM wallet_warmup_session_journals_v2 WHERE owner_id=NEW.owner_id AND id=NEW.journal_id)) AND p.archived=0 AND p.document=json_extract((SELECT source FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=(SELECT review_id FROM wallet_warmup_session_journals_v2 WHERE owner_id=NEW.owner_id AND id=NEW.journal_id)),'$.planDocument') AND p.updated_at=json_extract((SELECT source FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=(SELECT review_id FROM wallet_warmup_session_journals_v2 WHERE owner_id=NEW.owner_id AND id=NEW.journal_id)),'$.planUpdatedAt') AND json_extract(p.document,'$.chain')='Solana')
 OR json_array_length((SELECT document FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=(SELECT review_id FROM wallet_warmup_session_journals_v2 WHERE owner_id=NEW.owner_id AND id=NEW.journal_id)),'$.wallets')!=json_array_length(json_extract((SELECT source FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=(SELECT review_id FROM wallet_warmup_session_journals_v2 WHERE owner_id=NEW.owner_id AND id=NEW.journal_id)),'$.planDocument'),'$.addresses')
 OR EXISTS(SELECT 1 FROM json_each((SELECT document FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=(SELECT review_id FROM wallet_warmup_session_journals_v2 WHERE owner_id=NEW.owner_id AND id=NEW.journal_id)),'$.wallets') j WHERE json_type(j.value,'$.wallet') IS NOT 'text' OR json_type(j.value,'$.walletRevision') IS NOT 'integer' OR json_extract(j.value,'$.walletRevision')<1 OR NOT EXISTS(SELECT 1 FROM json_each(json_extract((SELECT source FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=(SELECT review_id FROM wallet_warmup_session_journals_v2 WHERE owner_id=NEW.owner_id AND id=NEW.journal_id)),'$.planDocument'),'$.addresses') a WHERE a.value=json_extract(j.value,'$.wallet')) OR NOT EXISTS(SELECT 1 FROM workspace_wallets w,json_each(json_extract((SELECT source FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=(SELECT review_id FROM wallet_warmup_session_journals_v2 WHERE owner_id=NEW.owner_id AND id=NEW.journal_id)),'$.planDocument'),'$.walletRevisions') c WHERE w.owner_id=NEW.owner_id AND w.chain='Solana' AND w.archived=0 AND w.address=json_extract(j.value,'$.wallet') AND w.revision=json_extract(j.value,'$.walletRevision') AND w.address=json_extract(c.value,'$.address') AND w.revision=json_extract(c.value,'$.revision')))) THEN RAISE(ABORT,'Warmup session plan or wallets changed') END;
 SELECT CASE WHEN json_extract(NEW.document,'$.operation') IN ('begin-review','resume') AND ( EXISTS(SELECT 1 FROM json_each((SELECT document FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=(SELECT review_id FROM wallet_warmup_session_journals_v2 WHERE owner_id=NEW.owner_id AND id=NEW.journal_id)),'$.wallets') j JOIN solana_swap_reservations r ON r.owner_id=NEW.owner_id AND r.wallet_address=json_extract(j.value,'$.wallet'))
 OR EXISTS(SELECT 1 FROM json_each((SELECT document FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=(SELECT review_id FROM wallet_warmup_session_journals_v2 WHERE owner_id=NEW.owner_id AND id=NEW.journal_id)),'$.wallets') j JOIN solana_execution_reservations r ON r.owner_id=NEW.owner_id AND r.wallet_address=json_extract(j.value,'$.wallet'))) THEN RAISE(ABORT,'Warmup session wallet needs recovery') END;
 SELECT CASE WHEN json_extract(NEW.document,'$.operation') IN ('begin-review','resume') AND ( (SELECT count(*) FROM warmup_buy_receipts r WHERE r.owner_id=NEW.owner_id AND r.plan_id=(SELECT plan_id FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=(SELECT review_id FROM wallet_warmup_session_journals_v2 WHERE owner_id=NEW.owner_id AND id=NEW.journal_id)))!=json_array_length((SELECT source FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=(SELECT review_id FROM wallet_warmup_session_journals_v2 WHERE owner_id=NEW.owner_id AND id=NEW.journal_id)),'$.buys')
 OR EXISTS(SELECT 1 FROM json_each((SELECT source FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=(SELECT review_id FROM wallet_warmup_session_journals_v2 WHERE owner_id=NEW.owner_id AND id=NEW.journal_id)),'$.buys') j WHERE NOT EXISTS(SELECT 1 FROM warmup_buy_receipts r WHERE r.owner_id=NEW.owner_id AND r.plan_id=(SELECT plan_id FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=(SELECT review_id FROM wallet_warmup_session_journals_v2 WHERE owner_id=NEW.owner_id AND id=NEW.journal_id)) AND r.id=json_extract(j.value,'$.id') AND r.plan_revision=json_extract(j.value,'$.planRevision') AND r.wallet_revision=json_extract(j.value,'$.walletRevision') AND r.cycle=json_extract(j.value,'$.cycle') AND r.wallet_address=json_extract(j.value,'$.wallet') AND r.document=json_extract(j.value,'$.document') AND COALESCE(r.remaining_raw,json_extract(r.document,'$.acquiredRaw'))=json_extract(j.value,'$.remainingRaw') AND json_extract(r.document,'$.wallet')=r.wallet_address AND json_extract(r.document,'$.signature')=r.signature AND json_extract(r.document,'$.signatureVerified')=1 AND json_extract(r.document,'$.network')='mainnet' AND json_extract(r.document,'$.commitment')='finalized'))
 OR (SELECT count(*) FROM warmup_sell_receipts r WHERE r.owner_id=NEW.owner_id AND r.plan_id=(SELECT plan_id FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=(SELECT review_id FROM wallet_warmup_session_journals_v2 WHERE owner_id=NEW.owner_id AND id=NEW.journal_id)))!=json_array_length((SELECT source FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=(SELECT review_id FROM wallet_warmup_session_journals_v2 WHERE owner_id=NEW.owner_id AND id=NEW.journal_id)),'$.sells')
 OR EXISTS(SELECT 1 FROM json_each((SELECT source FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=(SELECT review_id FROM wallet_warmup_session_journals_v2 WHERE owner_id=NEW.owner_id AND id=NEW.journal_id)),'$.sells') j WHERE NOT EXISTS(SELECT 1 FROM warmup_sell_receipts r WHERE r.owner_id=NEW.owner_id AND r.plan_id=(SELECT plan_id FROM wallet_warmup_session_reviews WHERE owner_id=NEW.owner_id AND id=(SELECT review_id FROM wallet_warmup_session_journals_v2 WHERE owner_id=NEW.owner_id AND id=NEW.journal_id)) AND r.id=json_extract(j.value,'$.id') AND r.buy_receipt_id=json_extract(j.value,'$.buyId') AND r.consumed_raw=json_extract(j.value,'$.consumedRaw') AND r.document=json_extract(j.value,'$.document') AND json_extract(r.document,'$.signature')=r.signature AND json_extract(r.document,'$.signatureVerified')=1 AND json_extract(r.document,'$.buyReceiptId')=r.buy_receipt_id AND json_extract(r.document,'$.consumedRaw')=r.consumed_raw AND json_extract(r.document,'$.network')='mainnet' AND json_extract(r.document,'$.commitment')='finalized'))) THEN RAISE(ABORT,'Warmup session receipt baseline changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_journal_events_v2_head AFTER INSERT ON wallet_warmup_session_journal_events_v2 BEGIN
 UPDATE wallet_warmup_session_journal_heads_v2 SET version=NEW.version,head_sha256=NEW.event_sha256,document_bytes=document_bytes+length(CAST(NEW.document AS BLOB)),updated_at=NEW.created_at WHERE owner_id=NEW.owner_id AND journal_id=NEW.journal_id;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_journals_legacy_id_isolation BEFORE INSERT ON wallet_warmup_session_journals WHEN EXISTS(SELECT 1 FROM wallet_warmup_session_journals_v2 j WHERE j.owner_id=NEW.owner_id AND j.id=NEW.id) BEGIN
 SELECT RAISE(ABORT,'Versioned warmup history already uses this ID');
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_v2_review_exclusion BEFORE INSERT ON wallet_warmup_session_journal_events_v2 WHEN json_extract(NEW.document,'$.operation') IN ('begin-review','resume') BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM wallet_warmup_session_journals_v2 own JOIN wallet_warmup_session_reviews r ON r.owner_id=own.owner_id AND r.id=own.review_id,json_each(r.document,'$.wallets') w
 WHERE own.owner_id=NEW.owner_id AND own.id=NEW.journal_id AND (
 EXISTS(SELECT 1 FROM wallet_warmup_session_journals_v2 j JOIN wallet_warmup_session_consents_v2 c ON c.owner_id=j.owner_id AND c.id=j.consent_id JOIN wallet_warmup_session_reviews peer ON peer.owner_id=j.owner_id AND peer.id=j.review_id,json_each(peer.document,'$.wallets') p
 WHERE j.owner_id=NEW.owner_id AND j.id!=NEW.journal_id AND json_extract(p.value,'$.wallet')=json_extract(w.value,'$.wallet') AND julianday('now')<julianday(json_extract(c.document,'$.sessionExpiresAt'))
 AND EXISTS(SELECT 1 FROM wallet_warmup_session_journal_events_v2 e WHERE e.owner_id=j.owner_id AND e.journal_id=j.id AND json_extract(e.document,'$.operation')='begin-review')
 AND NOT EXISTS(SELECT 1 FROM wallet_warmup_session_journal_events_v2 e WHERE e.owner_id=j.owner_id AND e.journal_id=j.id AND json_extract(e.document,'$.operation')='stop'))
 OR EXISTS(SELECT 1 FROM wallet_warmup_session_journals j JOIN wallet_warmup_session_consents c ON c.owner_id=j.owner_id AND c.id=j.consent_id,json_each(j.source_document,'$.review.wallets') p
 WHERE j.owner_id=NEW.owner_id AND json_extract(p.value,'$.wallet')=json_extract(w.value,'$.wallet')
 AND EXISTS(SELECT 1 FROM wallet_warmup_session_journal_events e WHERE e.owner_id=j.owner_id AND e.journal_id=j.id
 AND json_extract(e.document,'$.operation') IN ('begin-review','submitted','unknown')
 AND NOT EXISTS(SELECT 1 FROM wallet_warmup_session_journal_events f WHERE f.owner_id=e.owner_id AND f.journal_id=e.journal_id AND f.version>e.version AND json_extract(f.document,'$.actionId')=json_extract(e.document,'$.actionId') AND json_extract(f.document,'$.operation')='finalized')
 AND (json_extract(e.document,'$.operation') IN ('submitted','unknown') OR (julianday('now')<julianday(json_extract(j.source_document,'$.reviewExpiresAt')) AND julianday('now')<julianday(json_extract(c.document,'$.sessionExpiresAt')) AND NOT EXISTS(SELECT 1 FROM wallet_warmup_session_journal_events s WHERE s.owner_id=j.owner_id AND s.journal_id=j.id AND json_extract(s.document,'$.operation')='stop')))))
 OR EXISTS(SELECT 1 FROM wallet_warmup_session_preparations prep JOIN wallet_warmup_session_packets packet ON packet.owner_id=prep.owner_id AND packet.preparation_id=prep.preparation_id
 WHERE prep.owner_id=NEW.owner_id AND prep.wallet_address=json_extract(w.value,'$.wallet')
 AND NOT EXISTS(SELECT 1 FROM wallet_warmup_session_journal_events final WHERE final.owner_id=prep.owner_id AND final.journal_id=prep.journal_id AND final.version>prep.review_version AND json_extract(final.document,'$.operation')='finalized' AND json_extract(final.document,'$.actionId')=prep.action_id))))
 THEN RAISE(ABORT,'Another warmup review uses a selected wallet; recover or Stop it first') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_legacy_review_exclusion BEFORE INSERT ON wallet_warmup_session_journal_events WHEN json_extract(NEW.document,'$.operation')='begin-review' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM wallet_warmup_session_journals own,json_each(own.source_document,'$.review.wallets') w
 WHERE own.owner_id=NEW.owner_id AND own.id=NEW.journal_id AND EXISTS(
 SELECT 1 FROM wallet_warmup_session_journals_v2 j JOIN wallet_warmup_session_consents_v2 c ON c.owner_id=j.owner_id AND c.id=j.consent_id JOIN wallet_warmup_session_reviews r ON r.owner_id=j.owner_id AND r.id=j.review_id,json_each(r.document,'$.wallets') p
 WHERE j.owner_id=NEW.owner_id AND json_extract(p.value,'$.wallet')=json_extract(w.value,'$.wallet') AND julianday('now')<julianday(json_extract(c.document,'$.sessionExpiresAt'))
 AND EXISTS(SELECT 1 FROM wallet_warmup_session_journal_events_v2 e WHERE e.owner_id=j.owner_id AND e.journal_id=j.id AND json_extract(e.document,'$.operation')='begin-review')
 AND NOT EXISTS(SELECT 1 FROM wallet_warmup_session_journal_events_v2 e WHERE e.owner_id=j.owner_id AND e.journal_id=j.id AND json_extract(e.document,'$.operation')='stop')))
 THEN RAISE(ABORT,'A versioned warmup review uses a selected wallet; Stop it first') END;
END;
