CREATE TABLE wallet_warmup_execution_proposal_stages (
 owner_id TEXT NOT NULL, id TEXT NOT NULL, consent_id TEXT NOT NULL, review_id TEXT NOT NULL,
 review_sha256 TEXT NOT NULL, source_snapshot_sha256 TEXT NOT NULL, request_sha256 TEXT NOT NULL,
 header TEXT NOT NULL CHECK(json_valid(header)), header_sha256 TEXT NOT NULL,
 byte_length INTEGER NOT NULL, evidence_checked_at TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,id), UNIQUE(owner_id,consent_id), UNIQUE(owner_id,review_id),
 FOREIGN KEY(owner_id,review_id) REFERENCES wallet_warmup_session_reviews(owner_id,id)
);
--> statement-breakpoint
CREATE TABLE wallet_warmup_execution_proposal_chunks (
 owner_id TEXT NOT NULL, proposal_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
 data BLOB NOT NULL, sha256 TEXT NOT NULL,
 PRIMARY KEY(owner_id,proposal_id,chunk_index),
 FOREIGN KEY(owner_id,proposal_id) REFERENCES wallet_warmup_execution_proposal_stages(owner_id,id)
);
--> statement-breakpoint
CREATE TABLE wallet_warmup_execution_proposal_publications (
 owner_id TEXT NOT NULL, proposal_id TEXT NOT NULL, header_sha256 TEXT NOT NULL, published_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,proposal_id),
 FOREIGN KEY(owner_id,proposal_id) REFERENCES wallet_warmup_execution_proposal_stages(owner_id,id)
);
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_stage_insert BEFORE INSERT ON wallet_warmup_execution_proposal_stages BEGIN
 SELECT CASE WHEN (((((((length(NEW.owner_id) NOT BETWEEN 1 AND 128)
 OR (NEW.owner_id GLOB '*[^a-zA-Z0-9_-]*'))
 OR ((length(NEW.id)!=36)
 OR (NEW.id GLOB '*[^a-f0-9-]*')))
 OR (((length(replace(NEW.id,'-',''))!=32)
 OR (substr(NEW.id,9,1)!='-'))
 OR ((substr(NEW.id,14,1)!='-')
 OR (substr(NEW.id,19,1)!='-'))))
 OR ((((substr(NEW.id,24,1)!='-')
 OR (length(NEW.consent_id)!=36))
 OR ((NEW.consent_id GLOB '*[^a-f0-9-]*')
 OR (length(replace(NEW.consent_id,'-',''))!=32)))
 OR (((substr(NEW.consent_id,9,1)!='-')
 OR (substr(NEW.consent_id,14,1)!='-'))
 OR ((substr(NEW.consent_id,19,1)!='-')
 OR ((substr(NEW.consent_id,24,1)!='-')
 OR (length(NEW.review_id)!=36))))))
 OR (((((NEW.review_id GLOB '*[^a-f0-9-]*')
 OR (length(replace(NEW.review_id,'-',''))!=32))
 OR ((substr(NEW.review_id,9,1)!='-')
 OR (substr(NEW.review_id,14,1)!='-')))
 OR (((substr(NEW.review_id,19,1)!='-')
 OR (substr(NEW.review_id,24,1)!='-'))
 OR ((NEW.id=NEW.consent_id)
 OR (NEW.id=NEW.review_id))))
 OR ((((NEW.consent_id=NEW.review_id)
 OR (length(NEW.review_sha256)!=64))
 OR ((NEW.review_sha256 GLOB '*[^a-f0-9]*')
 OR (length(NEW.source_snapshot_sha256)!=64)))
 OR (((NEW.source_snapshot_sha256 GLOB '*[^a-f0-9]*')
 OR (length(NEW.request_sha256)!=64))
 OR ((NEW.request_sha256 GLOB '*[^a-f0-9]*')
 OR ((length(NEW.header_sha256)!=64)
 OR (NEW.header_sha256 GLOB '*[^a-f0-9]*')))))))
 OR ((((((typeof(NEW.byte_length)!='integer')
 OR (NEW.byte_length NOT BETWEEN 1 AND 67108864))
 OR ((length(CAST(NEW.header AS BLOB))>131072)
 OR (NEW.created_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ','now'))))
 OR (((strftime('%Y-%m-%dT%H:%M:%fZ',NEW.evidence_checked_at) IS NOT NEW.evidence_checked_at)
 OR (NEW.created_at<NEW.evidence_checked_at))
 OR ((strftime('%Y-%m-%dT%H:%M:%fZ',NEW.expires_at) IS NOT NEW.expires_at)
 OR (NEW.expires_at<=NEW.created_at))))
 OR (((((SELECT count(*) FROM json_each(NEW.header))!=11)
 OR (json_extract(NEW.header,'$.format') IS NOT 'wallet-warmup-execution-proposal-blobs-v1'))
 OR ((json_extract(NEW.header,'$.id') IS NOT NEW.id)
 OR (json_extract(NEW.header,'$.ownerId') IS NOT NEW.owner_id)))
 OR (((json_extract(NEW.header,'$.consentId') IS NOT NEW.consent_id)
 OR (json_extract(NEW.header,'$.reviewId') IS NOT NEW.review_id))
 OR ((json_extract(NEW.header,'$.bytes') IS NOT NEW.byte_length)
 OR ((json_extract(NEW.header,'$.proposalExpiresAt') IS NOT NEW.expires_at)
 OR (json_type(NEW.header,'$.proposalSha256') IS NOT 'text'))))))
 OR (((((length(json_extract(NEW.header,'$.proposalSha256'))!=64)
 OR (json_extract(NEW.header,'$.proposalSha256') GLOB '*[^a-f0-9]*'))
 OR ((json_type(NEW.header,'$.termsSha256') IS NOT 'text')
 OR (length(json_extract(NEW.header,'$.termsSha256'))!=64)))
 OR (((json_extract(NEW.header,'$.termsSha256') GLOB '*[^a-f0-9]*')
 OR (json_type(NEW.header,'$.verifierEvidenceSha256') IS NOT 'text'))
 OR ((length(json_extract(NEW.header,'$.verifierEvidenceSha256'))!=64)
 OR (json_extract(NEW.header,'$.verifierEvidenceSha256') GLOB '*[^a-f0-9]*'))))
 OR ((((json_type(NEW.header,'$.chunks') IS NOT 'array')
 OR (json_array_length(NEW.header,'$.chunks')!=(NEW.byte_length+196607)/196608))
 OR ((EXISTS(SELECT 1 FROM json_each(NEW.header,'$.chunks') c WHERE json_type(c.value) IS NOT 'object' OR (SELECT count(*) FROM json_each(c.value))!=3 OR json_extract(c.value,'$.index') IS NOT c.key OR json_type(c.value,'$.bytes') IS NOT 'integer' OR json_extract(c.value,'$.bytes')!=min(196608,NEW.byte_length-c.key*196608) OR json_type(c.value,'$.sha256') IS NOT 'text' OR length(json_extract(c.value,'$.sha256'))!=64 OR json_extract(c.value,'$.sha256') GLOB '*[^a-f0-9]*'))
 OR (NOT EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND r.review_sha256=NEW.review_sha256 AND NEW.created_at>=r.reviewed_at AND NEW.created_at>=r.created_at AND NEW.expires_at<=r.review_expires_at))))
 OR (((EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages p WHERE p.owner_id=NEW.owner_id AND (p.id IN (NEW.id,NEW.consent_id,NEW.review_id) OR p.consent_id IN (NEW.id,NEW.consent_id,NEW.review_id) OR p.review_id IN (NEW.id,NEW.consent_id,NEW.review_id))))
 OR ((SELECT count(*) FROM wallet_warmup_execution_proposal_stages p WHERE p.owner_id=NEW.owner_id)>=128))
 OR ((coalesce((SELECT sum(p.byte_length) FROM wallet_warmup_execution_proposal_stages p WHERE p.owner_id=NEW.owner_id),0)+NEW.byte_length>268435456)
 OR ((EXISTS(SELECT 1 FROM wallet_warmup_session_consents c WHERE c.owner_id=NEW.owner_id AND (c.id IN (NEW.id,NEW.consent_id,NEW.review_id) OR c.review_id IN (NEW.id,NEW.consent_id,NEW.review_id))))
 OR (EXISTS(SELECT 1 FROM wallet_warmup_session_consents_v2 c WHERE c.owner_id=NEW.owner_id AND (c.id IN (NEW.id,NEW.consent_id,NEW.review_id) OR c.review_id IN (NEW.id,NEW.consent_id,NEW.review_id))))))))))) THEN RAISE(ABORT,'Warmup proposal staging refused') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_chunk_insert BEFORE INSERT ON wallet_warmup_execution_proposal_chunks BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_chunks c WHERE c.owner_id=NEW.owner_id AND c.proposal_id=NEW.proposal_id AND c.chunk_index=NEW.chunk_index)
 OR typeof(NEW.chunk_index)!='integer' OR NEW.chunk_index NOT BETWEEN 0 AND 341
 OR typeof(NEW.data)!='blob' OR length(NEW.data) NOT BETWEEN 1 AND 196608
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages p
  WHERE p.owner_id=NEW.owner_id AND p.id=NEW.proposal_id
  AND strftime('%Y-%m-%dT%H:%M:%fZ','now')<p.expires_at
  AND json_extract(p.header,'$.chunks['||NEW.chunk_index||'].index') IS NEW.chunk_index
  AND json_extract(p.header,'$.chunks['||NEW.chunk_index||'].bytes') IS length(NEW.data)
  AND json_extract(p.header,'$.chunks['||NEW.chunk_index||'].sha256') IS NEW.sha256)
 OR EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_publications p WHERE p.owner_id=NEW.owner_id AND p.proposal_id=NEW.proposal_id)
 THEN RAISE(ABORT,'Warmup proposal chunk refused') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_publication_insert BEFORE INSERT ON wallet_warmup_execution_proposal_publications BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_publications p WHERE p.owner_id=NEW.owner_id AND p.proposal_id=NEW.proposal_id)
 OR NEW.published_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages p WHERE p.owner_id=NEW.owner_id AND p.id=NEW.proposal_id
  AND p.header_sha256=NEW.header_sha256 AND NEW.published_at>=p.created_at AND NEW.published_at<p.expires_at
  AND (SELECT count(*) FROM wallet_warmup_execution_proposal_chunks c WHERE c.owner_id=p.owner_id AND c.proposal_id=p.id)=json_array_length(p.header,'$.chunks')
  AND (SELECT sum(length(c.data)) FROM wallet_warmup_execution_proposal_chunks c WHERE c.owner_id=p.owner_id AND c.proposal_id=p.id)=p.byte_length)
 THEN RAISE(ABORT,'Warmup proposal publication refused') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_stage_no_update BEFORE UPDATE ON wallet_warmup_execution_proposal_stages BEGIN SELECT RAISE(ABORT,'Warmup proposal records are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_stage_no_delete BEFORE DELETE ON wallet_warmup_execution_proposal_stages BEGIN SELECT RAISE(ABORT,'Warmup proposal records are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_chunk_no_update BEFORE UPDATE ON wallet_warmup_execution_proposal_chunks BEGIN SELECT RAISE(ABORT,'Warmup proposal records are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_chunk_no_delete BEFORE DELETE ON wallet_warmup_execution_proposal_chunks BEGIN SELECT RAISE(ABORT,'Warmup proposal records are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_publication_no_update BEFORE UPDATE ON wallet_warmup_execution_proposal_publications BEGIN SELECT RAISE(ABORT,'Warmup proposal records are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_publication_no_delete BEFORE DELETE ON wallet_warmup_execution_proposal_publications BEGIN SELECT RAISE(ABORT,'Warmup proposal records are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_legacy_isolation BEFORE INSERT ON wallet_warmup_session_consents WHEN EXISTS(
 SELECT 1 FROM wallet_warmup_execution_proposal_stages p WHERE p.owner_id=NEW.owner_id
 AND (NEW.id IN (p.id,p.consent_id,p.review_id) OR NEW.review_id IN (p.id,p.consent_id,p.review_id))) BEGIN
 SELECT RAISE(ABORT,'Execution proposals cannot become legacy approvals');
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_v2_isolation BEFORE INSERT ON wallet_warmup_session_consents_v2 WHEN EXISTS(
 SELECT 1 FROM wallet_warmup_execution_proposal_stages p WHERE p.owner_id=NEW.owner_id
 AND (NEW.id IN (p.id,p.consent_id,p.review_id) OR NEW.review_id IN (p.id,p.consent_id,p.review_id))) BEGIN
 SELECT RAISE(ABORT,'Execution proposals cannot become legacy approvals');
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_stage_current_0 BEFORE INSERT ON wallet_warmup_execution_proposal_stages BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND r.review_sha256=NEW.review_sha256 AND (strftime('%Y-%m-%dT%H:%M:%fZ','now')>=r.reviewed_at)) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_stage_current_1 BEFORE INSERT ON wallet_warmup_execution_proposal_stages BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND r.review_sha256=NEW.review_sha256 AND (strftime('%Y-%m-%dT%H:%M:%fZ','now')>=r.created_at)) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_stage_current_2 BEFORE INSERT ON wallet_warmup_execution_proposal_stages BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND r.review_sha256=NEW.review_sha256 AND (strftime('%Y-%m-%dT%H:%M:%fZ','now')<r.review_expires_at)) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_stage_current_3 BEFORE INSERT ON wallet_warmup_execution_proposal_stages BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND r.review_sha256=NEW.review_sha256 AND (EXISTS(SELECT 1 FROM wallet_warmup_plans p WHERE p.owner_id=r.owner_id AND p.id=r.plan_id
  AND p.revision=r.plan_revision AND p.archived=0 AND json_extract(p.document,'$.chain')='Solana'
  AND p.document=json_extract(r.source,'$.planDocument') AND p.updated_at=json_extract(r.source,'$.planUpdatedAt')))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_stage_current_4 BEFORE INSERT ON wallet_warmup_execution_proposal_stages BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND r.review_sha256=NEW.review_sha256 AND (NOT EXISTS(SELECT 1 FROM json_each(r.document,'$.wallets') selected
  WHERE NOT EXISTS(SELECT 1 FROM workspace_wallets w WHERE w.owner_id=r.owner_id AND w.chain='Solana'
   AND w.address=json_extract(selected.value,'$.wallet') AND w.revision=json_extract(selected.value,'$.walletRevision') AND w.archived=0)
  OR EXISTS(SELECT 1 FROM solana_swap_reservations x WHERE x.owner_id=r.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet'))
  OR EXISTS(SELECT 1 FROM solana_execution_reservations x WHERE x.owner_id=r.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_stage_current_5_busy_0 BEFORE INSERT ON wallet_warmup_execution_proposal_stages BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND r.review_sha256=NEW.review_sha256 AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM pair_order_executions e WHERE e.owner_id=c.owner_id
  AND e.wallet=json_extract(selected.value,'$.wallet') AND e.state IN ('reserved','signed','submitting','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_stage_current_5_busy_1 BEFORE INSERT ON wallet_warmup_execution_proposal_stages BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND r.review_sha256=NEW.review_sha256 AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM imported_swap_signing_intents i WHERE i.owner_id=c.owner_id
  AND i.wallet_address=json_extract(selected.value,'$.wallet') AND i.state IN ('awaiting_signature','signed','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_stage_current_5_busy_2 BEFORE INSERT ON wallet_warmup_execution_proposal_stages BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND r.review_sha256=NEW.review_sha256 AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM warmup_signing_intents i WHERE i.owner_id=c.owner_id
  AND i.wallet_address=json_extract(selected.value,'$.wallet') AND i.state IN ('awaiting_signature','signed','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_stage_current_5_busy_3 BEFORE INSERT ON wallet_warmup_execution_proposal_stages BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND r.review_sha256=NEW.review_sha256 AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM pump_launch_reviews r WHERE r.owner_id=c.owner_id
  AND r.state NOT IN ('cancelled','failed','finalized') AND (r.payer=json_extract(selected.value,'$.wallet')
   OR EXISTS(SELECT 1 FROM json_each(r.review,'$.input.holders') h
    WHERE json_extract(r.review,'$.format') IN ('pump-create-holders-review-v1','pump-launch-group-review-v1')
    AND json_extract(h.value,'$.kind')!='none' AND json_extract(h.value,'$.address')=json_extract(selected.value,'$.wallet'))))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_stage_current_5_busy_4 BEFORE INSERT ON wallet_warmup_execution_proposal_stages BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND r.review_sha256=NEW.review_sha256 AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM volume_bot_sessions s,json_each(s.plan,'$.wallets') w
  WHERE s.owner_id=c.owner_id AND w.value=json_extract(selected.value,'$.wallet')
  AND (s.state='active' OR EXISTS(SELECT 1 FROM volume_bot_batches batch JOIN volume_bot_trades t ON t.batch_id=batch.id
   WHERE batch.session_id=s.id AND t.state IN ('signed','submitting','submitted'))))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_stage_current_5_busy_5 BEFORE INSERT ON wallet_warmup_execution_proposal_stages BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND r.review_sha256=NEW.review_sha256 AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM volume_bundle_reservations b WHERE b.owner_id=c.owner_id
  AND b.wallet=json_extract(selected.value,'$.wallet') AND b.state IN ('held','attempted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_stage_current_5_busy_6 BEFORE INSERT ON wallet_warmup_execution_proposal_stages BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND r.review_sha256=NEW.review_sha256 AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM pump_organic_sequences s,json_each(s.plan,'$.rows') w
  WHERE s.owner_id=c.owner_id AND json_extract(w.value,'$.address')=json_extract(selected.value,'$.wallet')
  AND (s.state='active' OR EXISTS(SELECT 1 FROM pump_organic_batches batch JOIN pump_organic_buys t ON t.batch_id=batch.id
   WHERE batch.sequence_id=s.id AND t.state IN ('signed','submitting','submitted'))))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_stage_current_5_busy_7 BEFORE INSERT ON wallet_warmup_execution_proposal_stages BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND r.review_sha256=NEW.review_sha256 AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM wallet_cleanups x WHERE x.owner_id=c.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet')
  AND x.state IN ('awaiting_signature','signing','signed','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_stage_current_5_busy_8 BEFORE INSERT ON wallet_warmup_execution_proposal_stages BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND r.review_sha256=NEW.review_sha256 AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM token_supply_actions x WHERE x.owner_id=c.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet')
  AND x.state IN ('awaiting_signature','signing','signed','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_stage_current_5_busy_9 BEFORE INSERT ON wallet_warmup_execution_proposal_stages BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND r.review_sha256=NEW.review_sha256 AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM sniper_nuke_sells x WHERE x.owner_id=c.owner_id AND x.wallet=json_extract(selected.value,'$.wallet')
  AND x.state IN ('review','signed','submitting','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_stage_current_5_busy_10 BEFORE INSERT ON wallet_warmup_execution_proposal_stages BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND r.review_sha256=NEW.review_sha256 AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM counter_proposal_reservations x WHERE x.owner_id=c.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet')
  AND (x.approval_id IS NOT NULL OR x.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_stage_current_6 BEFORE INSERT ON wallet_warmup_execution_proposal_stages BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND r.review_sha256=NEW.review_sha256 AND ((SELECT count(*) FROM warmup_buy_receipts b WHERE b.owner_id=r.owner_id AND b.plan_id=r.plan_id)=json_array_length(r.source,'$.buys'))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_stage_current_7 BEFORE INSERT ON wallet_warmup_execution_proposal_stages BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND r.review_sha256=NEW.review_sha256 AND (NOT EXISTS(SELECT 1 FROM json_each(r.source,'$.buys') j WHERE NOT EXISTS(
  SELECT 1 FROM warmup_buy_receipts b WHERE b.owner_id=r.owner_id AND b.plan_id=r.plan_id AND (b.id) IS json_extract(j.value,'$.id') AND (b.plan_revision) IS json_extract(j.value,'$.planRevision') AND (b.wallet_revision) IS json_extract(j.value,'$.walletRevision') AND (b.cycle) IS json_extract(j.value,'$.cycle') AND (b.wallet_address) IS json_extract(j.value,'$.wallet') AND (b.document) IS json_extract(j.value,'$.document') AND (json_extract(b.document,'$.mint')) IS json_extract(j.value,'$.mint') AND (json_extract(b.document,'$.acquiredRaw')) IS json_extract(j.value,'$.acquiredRaw') AND (COALESCE(b.remaining_raw,json_extract(b.document,'$.acquiredRaw'))) IS json_extract(j.value,'$.remainingRaw') AND (json_extract(b.document,'$.decimals')) IS json_extract(j.value,'$.decimals') AND ( CASE WHEN json_extract(b.document,'$.signatureVerified')=1 AND json_extract(b.document,'$.wallet')=b.wallet_address AND json_extract(b.document,'$.signature')=b.signature THEN 1 ELSE 0 END) IS json_extract(j.value,'$.verified') AND (json_extract(b.document,'$.commitment')) IS json_extract(j.value,'$.commitment') AND (json_extract(b.document,'$.network')) IS json_extract(j.value,'$.network'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_stage_current_8 BEFORE INSERT ON wallet_warmup_execution_proposal_stages BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND r.review_sha256=NEW.review_sha256 AND ((SELECT count(*) FROM warmup_sell_receipts s WHERE s.owner_id=r.owner_id AND s.plan_id=r.plan_id)=json_array_length(r.source,'$.sells'))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_stage_current_9 BEFORE INSERT ON wallet_warmup_execution_proposal_stages BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND r.review_sha256=NEW.review_sha256 AND (NOT EXISTS(SELECT 1 FROM json_each(r.source,'$.sells') j WHERE NOT EXISTS(
  SELECT 1 FROM warmup_sell_receipts s WHERE s.owner_id=r.owner_id AND s.plan_id=r.plan_id AND (s.id) IS json_extract(j.value,'$.id') AND (s.document) IS json_extract(j.value,'$.document') AND (s.buy_receipt_id) IS json_extract(j.value,'$.buyId') AND (s.consumed_raw) IS json_extract(j.value,'$.consumedRaw') AND ( CASE WHEN json_extract(s.document,'$.signatureVerified')=1 AND json_extract(s.document,'$.signature')=s.signature AND json_extract(s.document,'$.consumedRaw')=s.consumed_raw AND json_extract(s.document,'$.buyReceiptId')=s.buy_receipt_id THEN 1 ELSE 0 END) IS json_extract(j.value,'$.verified') AND (json_extract(s.document,'$.commitment')) IS json_extract(j.value,'$.commitment') AND (json_extract(s.document,'$.network')) IS json_extract(j.value,'$.network'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_publication_current_0 BEFORE INSERT ON wallet_warmup_execution_proposal_publications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (strftime('%Y-%m-%dT%H:%M:%fZ','now')>=r.reviewed_at)) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_publication_current_1 BEFORE INSERT ON wallet_warmup_execution_proposal_publications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (strftime('%Y-%m-%dT%H:%M:%fZ','now')>=r.created_at)) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_publication_current_2 BEFORE INSERT ON wallet_warmup_execution_proposal_publications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (strftime('%Y-%m-%dT%H:%M:%fZ','now')<r.review_expires_at)) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_publication_current_3 BEFORE INSERT ON wallet_warmup_execution_proposal_publications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (EXISTS(SELECT 1 FROM wallet_warmup_plans p WHERE p.owner_id=r.owner_id AND p.id=r.plan_id
  AND p.revision=r.plan_revision AND p.archived=0 AND json_extract(p.document,'$.chain')='Solana'
  AND p.document=json_extract(r.source,'$.planDocument') AND p.updated_at=json_extract(r.source,'$.planUpdatedAt')))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_publication_current_4 BEFORE INSERT ON wallet_warmup_execution_proposal_publications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM json_each(r.document,'$.wallets') selected
  WHERE NOT EXISTS(SELECT 1 FROM workspace_wallets w WHERE w.owner_id=r.owner_id AND w.chain='Solana'
   AND w.address=json_extract(selected.value,'$.wallet') AND w.revision=json_extract(selected.value,'$.walletRevision') AND w.archived=0)
  OR EXISTS(SELECT 1 FROM solana_swap_reservations x WHERE x.owner_id=r.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet'))
  OR EXISTS(SELECT 1 FROM solana_execution_reservations x WHERE x.owner_id=r.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_publication_current_5_busy_0 BEFORE INSERT ON wallet_warmup_execution_proposal_publications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM pair_order_executions e WHERE e.owner_id=c.owner_id
  AND e.wallet=json_extract(selected.value,'$.wallet') AND e.state IN ('reserved','signed','submitting','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_publication_current_5_busy_1 BEFORE INSERT ON wallet_warmup_execution_proposal_publications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM imported_swap_signing_intents i WHERE i.owner_id=c.owner_id
  AND i.wallet_address=json_extract(selected.value,'$.wallet') AND i.state IN ('awaiting_signature','signed','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_publication_current_5_busy_2 BEFORE INSERT ON wallet_warmup_execution_proposal_publications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM warmup_signing_intents i WHERE i.owner_id=c.owner_id
  AND i.wallet_address=json_extract(selected.value,'$.wallet') AND i.state IN ('awaiting_signature','signed','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_publication_current_5_busy_3 BEFORE INSERT ON wallet_warmup_execution_proposal_publications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM pump_launch_reviews r WHERE r.owner_id=c.owner_id
  AND r.state NOT IN ('cancelled','failed','finalized') AND (r.payer=json_extract(selected.value,'$.wallet')
   OR EXISTS(SELECT 1 FROM json_each(r.review,'$.input.holders') h
    WHERE json_extract(r.review,'$.format') IN ('pump-create-holders-review-v1','pump-launch-group-review-v1')
    AND json_extract(h.value,'$.kind')!='none' AND json_extract(h.value,'$.address')=json_extract(selected.value,'$.wallet'))))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_publication_current_5_busy_4 BEFORE INSERT ON wallet_warmup_execution_proposal_publications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM volume_bot_sessions s,json_each(s.plan,'$.wallets') w
  WHERE s.owner_id=c.owner_id AND w.value=json_extract(selected.value,'$.wallet')
  AND (s.state='active' OR EXISTS(SELECT 1 FROM volume_bot_batches batch JOIN volume_bot_trades t ON t.batch_id=batch.id
   WHERE batch.session_id=s.id AND t.state IN ('signed','submitting','submitted'))))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_publication_current_5_busy_5 BEFORE INSERT ON wallet_warmup_execution_proposal_publications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM volume_bundle_reservations b WHERE b.owner_id=c.owner_id
  AND b.wallet=json_extract(selected.value,'$.wallet') AND b.state IN ('held','attempted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_publication_current_5_busy_6 BEFORE INSERT ON wallet_warmup_execution_proposal_publications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM pump_organic_sequences s,json_each(s.plan,'$.rows') w
  WHERE s.owner_id=c.owner_id AND json_extract(w.value,'$.address')=json_extract(selected.value,'$.wallet')
  AND (s.state='active' OR EXISTS(SELECT 1 FROM pump_organic_batches batch JOIN pump_organic_buys t ON t.batch_id=batch.id
   WHERE batch.sequence_id=s.id AND t.state IN ('signed','submitting','submitted'))))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_publication_current_5_busy_7 BEFORE INSERT ON wallet_warmup_execution_proposal_publications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM wallet_cleanups x WHERE x.owner_id=c.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet')
  AND x.state IN ('awaiting_signature','signing','signed','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_publication_current_5_busy_8 BEFORE INSERT ON wallet_warmup_execution_proposal_publications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM token_supply_actions x WHERE x.owner_id=c.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet')
  AND x.state IN ('awaiting_signature','signing','signed','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_publication_current_5_busy_9 BEFORE INSERT ON wallet_warmup_execution_proposal_publications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM sniper_nuke_sells x WHERE x.owner_id=c.owner_id AND x.wallet=json_extract(selected.value,'$.wallet')
  AND x.state IN ('review','signed','submitting','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_publication_current_5_busy_10 BEFORE INSERT ON wallet_warmup_execution_proposal_publications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM counter_proposal_reservations x WHERE x.owner_id=c.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet')
  AND (x.approval_id IS NOT NULL OR x.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_publication_current_6 BEFORE INSERT ON wallet_warmup_execution_proposal_publications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND ((SELECT count(*) FROM warmup_buy_receipts b WHERE b.owner_id=r.owner_id AND b.plan_id=r.plan_id)=json_array_length(r.source,'$.buys'))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_publication_current_7 BEFORE INSERT ON wallet_warmup_execution_proposal_publications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM json_each(r.source,'$.buys') j WHERE NOT EXISTS(
  SELECT 1 FROM warmup_buy_receipts b WHERE b.owner_id=r.owner_id AND b.plan_id=r.plan_id AND (b.id) IS json_extract(j.value,'$.id') AND (b.plan_revision) IS json_extract(j.value,'$.planRevision') AND (b.wallet_revision) IS json_extract(j.value,'$.walletRevision') AND (b.cycle) IS json_extract(j.value,'$.cycle') AND (b.wallet_address) IS json_extract(j.value,'$.wallet') AND (b.document) IS json_extract(j.value,'$.document') AND (json_extract(b.document,'$.mint')) IS json_extract(j.value,'$.mint') AND (json_extract(b.document,'$.acquiredRaw')) IS json_extract(j.value,'$.acquiredRaw') AND (COALESCE(b.remaining_raw,json_extract(b.document,'$.acquiredRaw'))) IS json_extract(j.value,'$.remainingRaw') AND (json_extract(b.document,'$.decimals')) IS json_extract(j.value,'$.decimals') AND ( CASE WHEN json_extract(b.document,'$.signatureVerified')=1 AND json_extract(b.document,'$.wallet')=b.wallet_address AND json_extract(b.document,'$.signature')=b.signature THEN 1 ELSE 0 END) IS json_extract(j.value,'$.verified') AND (json_extract(b.document,'$.commitment')) IS json_extract(j.value,'$.commitment') AND (json_extract(b.document,'$.network')) IS json_extract(j.value,'$.network'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_publication_current_8 BEFORE INSERT ON wallet_warmup_execution_proposal_publications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND ((SELECT count(*) FROM warmup_sell_receipts s WHERE s.owner_id=r.owner_id AND s.plan_id=r.plan_id)=json_array_length(r.source,'$.sells'))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_proposal_publication_current_9 BEFORE INSERT ON wallet_warmup_execution_proposal_publications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM json_each(r.source,'$.sells') j WHERE NOT EXISTS(
  SELECT 1 FROM warmup_sell_receipts s WHERE s.owner_id=r.owner_id AND s.plan_id=r.plan_id AND (s.id) IS json_extract(j.value,'$.id') AND (s.document) IS json_extract(j.value,'$.document') AND (s.buy_receipt_id) IS json_extract(j.value,'$.buyId') AND (s.consumed_raw) IS json_extract(j.value,'$.consumedRaw') AND ( CASE WHEN json_extract(s.document,'$.signatureVerified')=1 AND json_extract(s.document,'$.signature')=s.signature AND json_extract(s.document,'$.consumedRaw')=s.consumed_raw AND json_extract(s.document,'$.buyReceiptId')=s.buy_receipt_id THEN 1 ELSE 0 END) IS json_extract(j.value,'$.verified') AND (json_extract(s.document,'$.commitment')) IS json_extract(j.value,'$.commitment') AND (json_extract(s.document,'$.network')) IS json_extract(j.value,'$.network'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
