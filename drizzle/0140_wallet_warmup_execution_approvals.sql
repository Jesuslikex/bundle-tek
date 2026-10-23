CREATE TABLE wallet_warmup_execution_approvals (
 owner_id TEXT NOT NULL, proposal_id TEXT NOT NULL, consent_id TEXT NOT NULL, review_id TEXT NOT NULL,
 header_sha256 TEXT NOT NULL, terms_sha256 TEXT NOT NULL, request_sha256 TEXT NOT NULL,
 approved_at TEXT NOT NULL, session_expires_at TEXT NOT NULL, pacing_before TEXT NOT NULL, acknowledgement TEXT NOT NULL,
 PRIMARY KEY(owner_id,proposal_id), UNIQUE(owner_id,consent_id), UNIQUE(owner_id,review_id),
 FOREIGN KEY(owner_id,proposal_id) REFERENCES wallet_warmup_execution_proposal_publications(owner_id,proposal_id)
);
--> statement-breakpoint
CREATE TABLE wallet_warmup_execution_roots (
 owner_id TEXT NOT NULL, proposal_id TEXT NOT NULL, consent_id TEXT NOT NULL, review_id TEXT NOT NULL,
 header_sha256 TEXT NOT NULL, terms_sha256 TEXT NOT NULL, consent_sha256 TEXT NOT NULL,
 root_sha256 TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,proposal_id), UNIQUE(owner_id,consent_id), UNIQUE(owner_id,review_id),
 FOREIGN KEY(owner_id,proposal_id) REFERENCES wallet_warmup_execution_approvals(owner_id,proposal_id)
);
--> statement-breakpoint
CREATE TRIGGER warmup_execution_approval_insert BEFORE INSERT ON wallet_warmup_execution_approvals BEGIN
 SELECT CASE WHEN ((((EXISTS(SELECT 1 FROM wallet_warmup_execution_approvals x WHERE x.owner_id=NEW.owner_id AND (x.proposal_id=NEW.proposal_id OR x.consent_id=NEW.consent_id OR x.review_id=NEW.review_id)))
 OR (NEW.approved_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ','now')))
 OR ((length(NEW.header_sha256)!=64 OR NEW.header_sha256 GLOB '*[^a-f0-9]*')
 OR ((length(NEW.terms_sha256)!=64 OR NEW.terms_sha256 GLOB '*[^a-f0-9]*')
 OR (length(NEW.request_sha256)!=64 OR NEW.request_sha256 GLOB '*[^a-f0-9]*'))))
 OR (((NEW.acknowledgement IS NOT 'I approve these exact wallets, actions, gross spending limits and expiry.')
 OR (strftime('%Y-%m-%dT%H:%M:%fZ',NEW.session_expires_at) IS NOT NEW.session_expires_at))
 OR ((strftime('%Y-%m-%dT%H:%M:%fZ',NEW.pacing_before) IS NOT NEW.pacing_before)
 OR ((NEW.pacing_before>NEW.session_expires_at OR NEW.approved_at>=NEW.pacing_before)
 OR (NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_publications pp JOIN wallet_warmup_execution_proposal_stages ps ON ps.owner_id=pp.owner_id AND ps.id=pp.proposal_id WHERE pp.owner_id=NEW.owner_id AND pp.proposal_id=NEW.proposal_id AND pp.header_sha256=NEW.header_sha256 AND ps.header_sha256=NEW.header_sha256 AND json_extract(ps.header,'$.termsSha256')=NEW.terms_sha256 AND ps.consent_id=NEW.consent_id AND ps.review_id=NEW.review_id AND NEW.approved_at>=pp.published_at AND NEW.approved_at<ps.expires_at)))))) THEN RAISE(ABORT,'Exact warmup approval refused') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_approval_no_update BEFORE UPDATE ON wallet_warmup_execution_approvals BEGIN SELECT RAISE(ABORT,'Warmup approval and root records are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_approval_no_delete BEFORE DELETE ON wallet_warmup_execution_approvals BEGIN SELECT RAISE(ABORT,'Warmup approval and root records are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_root_insert BEFORE INSERT ON wallet_warmup_execution_roots BEGIN
 SELECT CASE WHEN ((((EXISTS(SELECT 1 FROM wallet_warmup_execution_roots x WHERE x.owner_id=NEW.owner_id AND (x.proposal_id=NEW.proposal_id OR x.consent_id=NEW.consent_id OR x.review_id=NEW.review_id)))
 OR (NEW.created_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ','now')))
 OR ((length(NEW.header_sha256)!=64 OR NEW.header_sha256 GLOB '*[^a-f0-9]*')
 OR (length(NEW.terms_sha256)!=64 OR NEW.terms_sha256 GLOB '*[^a-f0-9]*')))
 OR (((length(NEW.consent_sha256)!=64 OR NEW.consent_sha256 GLOB '*[^a-f0-9]*')
 OR (length(NEW.root_sha256)!=64 OR NEW.root_sha256 GLOB '*[^a-f0-9]*'))
 OR ((length(NEW.manifest_sha256)!=64 OR NEW.manifest_sha256 GLOB '*[^a-f0-9]*')
 OR (NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_approvals a JOIN wallet_warmup_execution_proposal_stages ps ON ps.owner_id=a.owner_id AND ps.id=a.proposal_id WHERE a.owner_id=NEW.owner_id AND a.proposal_id=NEW.proposal_id AND a.consent_id=NEW.consent_id AND a.review_id=NEW.review_id AND a.header_sha256=NEW.header_sha256 AND a.terms_sha256=NEW.terms_sha256 AND NEW.created_at>=a.approved_at AND NEW.created_at<a.pacing_before AND NEW.created_at<ps.expires_at))))) THEN RAISE(ABORT,'Exact warmup root refused') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_root_no_update BEFORE UPDATE ON wallet_warmup_execution_roots BEGIN SELECT RAISE(ABORT,'Warmup approval and root records are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_root_no_delete BEFORE DELETE ON wallet_warmup_execution_roots BEGIN SELECT RAISE(ABORT,'Warmup approval and root records are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_approval_current_0 BEFORE INSERT ON wallet_warmup_execution_approvals BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (strftime('%Y-%m-%dT%H:%M:%fZ','now')>=r.reviewed_at)) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_approval_current_1 BEFORE INSERT ON wallet_warmup_execution_approvals BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (strftime('%Y-%m-%dT%H:%M:%fZ','now')>=r.created_at)) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_approval_current_2 BEFORE INSERT ON wallet_warmup_execution_approvals BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (strftime('%Y-%m-%dT%H:%M:%fZ','now')<r.review_expires_at)) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_approval_current_3 BEFORE INSERT ON wallet_warmup_execution_approvals BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (EXISTS(SELECT 1 FROM wallet_warmup_plans p WHERE p.owner_id=r.owner_id AND p.id=r.plan_id
  AND p.revision=r.plan_revision AND p.archived=0 AND json_extract(p.document,'$.chain')='Solana'
  AND p.document=json_extract(r.source,'$.planDocument') AND p.updated_at=json_extract(r.source,'$.planUpdatedAt')))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_approval_current_4 BEFORE INSERT ON wallet_warmup_execution_approvals BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM json_each(r.document,'$.wallets') selected
  WHERE NOT EXISTS(SELECT 1 FROM workspace_wallets w WHERE w.owner_id=r.owner_id AND w.chain='Solana'
   AND w.address=json_extract(selected.value,'$.wallet') AND w.revision=json_extract(selected.value,'$.walletRevision') AND w.archived=0)
  OR EXISTS(SELECT 1 FROM solana_swap_reservations x WHERE x.owner_id=r.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet'))
  OR EXISTS(SELECT 1 FROM solana_execution_reservations x WHERE x.owner_id=r.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_approval_current_5_busy_0 BEFORE INSERT ON wallet_warmup_execution_approvals BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM pair_order_executions e WHERE e.owner_id=c.owner_id
  AND e.wallet=json_extract(selected.value,'$.wallet') AND e.state IN ('reserved','signed','submitting','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_approval_current_5_busy_1 BEFORE INSERT ON wallet_warmup_execution_approvals BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM imported_swap_signing_intents i WHERE i.owner_id=c.owner_id
  AND i.wallet_address=json_extract(selected.value,'$.wallet') AND i.state IN ('awaiting_signature','signed','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_approval_current_5_busy_2 BEFORE INSERT ON wallet_warmup_execution_approvals BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM warmup_signing_intents i WHERE i.owner_id=c.owner_id
  AND i.wallet_address=json_extract(selected.value,'$.wallet') AND i.state IN ('awaiting_signature','signed','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_approval_current_5_busy_3 BEFORE INSERT ON wallet_warmup_execution_approvals BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM pump_launch_reviews r WHERE r.owner_id=c.owner_id
  AND r.state NOT IN ('cancelled','failed','finalized') AND (r.payer=json_extract(selected.value,'$.wallet')
   OR EXISTS(SELECT 1 FROM json_each(r.review,'$.input.holders') h
    WHERE json_extract(r.review,'$.format') IN ('pump-create-holders-review-v1','pump-launch-group-review-v1')
    AND json_extract(h.value,'$.kind')!='none' AND json_extract(h.value,'$.address')=json_extract(selected.value,'$.wallet'))))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_approval_current_5_busy_4 BEFORE INSERT ON wallet_warmup_execution_approvals BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM volume_bot_sessions s,json_each(s.plan,'$.wallets') w
  WHERE s.owner_id=c.owner_id AND w.value=json_extract(selected.value,'$.wallet')
  AND (s.state='active' OR EXISTS(SELECT 1 FROM volume_bot_batches batch JOIN volume_bot_trades t ON t.batch_id=batch.id
   WHERE batch.session_id=s.id AND t.state IN ('signed','submitting','submitted'))))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_approval_current_5_busy_5 BEFORE INSERT ON wallet_warmup_execution_approvals BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM volume_bundle_reservations b WHERE b.owner_id=c.owner_id
  AND b.wallet=json_extract(selected.value,'$.wallet') AND b.state IN ('held','attempted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_approval_current_5_busy_6 BEFORE INSERT ON wallet_warmup_execution_approvals BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM pump_organic_sequences s,json_each(s.plan,'$.rows') w
  WHERE s.owner_id=c.owner_id AND json_extract(w.value,'$.address')=json_extract(selected.value,'$.wallet')
  AND (s.state='active' OR EXISTS(SELECT 1 FROM pump_organic_batches batch JOIN pump_organic_buys t ON t.batch_id=batch.id
   WHERE batch.sequence_id=s.id AND t.state IN ('signed','submitting','submitted'))))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_approval_current_5_busy_7 BEFORE INSERT ON wallet_warmup_execution_approvals BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM wallet_cleanups x WHERE x.owner_id=c.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet')
  AND x.state IN ('awaiting_signature','signing','signed','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_approval_current_5_busy_8 BEFORE INSERT ON wallet_warmup_execution_approvals BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM token_supply_actions x WHERE x.owner_id=c.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet')
  AND x.state IN ('awaiting_signature','signing','signed','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_approval_current_5_busy_9 BEFORE INSERT ON wallet_warmup_execution_approvals BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM sniper_nuke_sells x WHERE x.owner_id=c.owner_id AND x.wallet=json_extract(selected.value,'$.wallet')
  AND x.state IN ('review','signed','submitting','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_approval_current_5_busy_10 BEFORE INSERT ON wallet_warmup_execution_approvals BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM counter_proposal_reservations x WHERE x.owner_id=c.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet')
  AND (x.approval_id IS NOT NULL OR x.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_approval_current_6 BEFORE INSERT ON wallet_warmup_execution_approvals BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND ((SELECT count(*) FROM warmup_buy_receipts b WHERE b.owner_id=r.owner_id AND b.plan_id=r.plan_id)=json_array_length(r.source,'$.buys'))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_approval_current_7 BEFORE INSERT ON wallet_warmup_execution_approvals BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM json_each(r.source,'$.buys') j WHERE NOT EXISTS(
  SELECT 1 FROM warmup_buy_receipts b WHERE b.owner_id=r.owner_id AND b.plan_id=r.plan_id AND (b.id) IS json_extract(j.value,'$.id') AND (b.plan_revision) IS json_extract(j.value,'$.planRevision') AND (b.wallet_revision) IS json_extract(j.value,'$.walletRevision') AND (b.cycle) IS json_extract(j.value,'$.cycle') AND (b.wallet_address) IS json_extract(j.value,'$.wallet') AND (b.document) IS json_extract(j.value,'$.document') AND (json_extract(b.document,'$.mint')) IS json_extract(j.value,'$.mint') AND (json_extract(b.document,'$.acquiredRaw')) IS json_extract(j.value,'$.acquiredRaw') AND (COALESCE(b.remaining_raw,json_extract(b.document,'$.acquiredRaw'))) IS json_extract(j.value,'$.remainingRaw') AND (json_extract(b.document,'$.decimals')) IS json_extract(j.value,'$.decimals') AND ( CASE WHEN json_extract(b.document,'$.signatureVerified')=1 AND json_extract(b.document,'$.wallet')=b.wallet_address AND json_extract(b.document,'$.signature')=b.signature THEN 1 ELSE 0 END) IS json_extract(j.value,'$.verified') AND (json_extract(b.document,'$.commitment')) IS json_extract(j.value,'$.commitment') AND (json_extract(b.document,'$.network')) IS json_extract(j.value,'$.network'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_approval_current_8 BEFORE INSERT ON wallet_warmup_execution_approvals BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND ((SELECT count(*) FROM warmup_sell_receipts s WHERE s.owner_id=r.owner_id AND s.plan_id=r.plan_id)=json_array_length(r.source,'$.sells'))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_approval_current_9 BEFORE INSERT ON wallet_warmup_execution_approvals BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM json_each(r.source,'$.sells') j WHERE NOT EXISTS(
  SELECT 1 FROM warmup_sell_receipts s WHERE s.owner_id=r.owner_id AND s.plan_id=r.plan_id AND (s.id) IS json_extract(j.value,'$.id') AND (s.document) IS json_extract(j.value,'$.document') AND (s.buy_receipt_id) IS json_extract(j.value,'$.buyId') AND (s.consumed_raw) IS json_extract(j.value,'$.consumedRaw') AND ( CASE WHEN json_extract(s.document,'$.signatureVerified')=1 AND json_extract(s.document,'$.signature')=s.signature AND json_extract(s.document,'$.consumedRaw')=s.consumed_raw AND json_extract(s.document,'$.buyReceiptId')=s.buy_receipt_id THEN 1 ELSE 0 END) IS json_extract(j.value,'$.verified') AND (json_extract(s.document,'$.commitment')) IS json_extract(j.value,'$.commitment') AND (json_extract(s.document,'$.network')) IS json_extract(j.value,'$.network'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_root_current_0 BEFORE INSERT ON wallet_warmup_execution_roots BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (strftime('%Y-%m-%dT%H:%M:%fZ','now')>=r.reviewed_at)) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_root_current_1 BEFORE INSERT ON wallet_warmup_execution_roots BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (strftime('%Y-%m-%dT%H:%M:%fZ','now')>=r.created_at)) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_root_current_2 BEFORE INSERT ON wallet_warmup_execution_roots BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (strftime('%Y-%m-%dT%H:%M:%fZ','now')<r.review_expires_at)) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_root_current_3 BEFORE INSERT ON wallet_warmup_execution_roots BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (EXISTS(SELECT 1 FROM wallet_warmup_plans p WHERE p.owner_id=r.owner_id AND p.id=r.plan_id
  AND p.revision=r.plan_revision AND p.archived=0 AND json_extract(p.document,'$.chain')='Solana'
  AND p.document=json_extract(r.source,'$.planDocument') AND p.updated_at=json_extract(r.source,'$.planUpdatedAt')))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_root_current_4 BEFORE INSERT ON wallet_warmup_execution_roots BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM json_each(r.document,'$.wallets') selected
  WHERE NOT EXISTS(SELECT 1 FROM workspace_wallets w WHERE w.owner_id=r.owner_id AND w.chain='Solana'
   AND w.address=json_extract(selected.value,'$.wallet') AND w.revision=json_extract(selected.value,'$.walletRevision') AND w.archived=0)
  OR EXISTS(SELECT 1 FROM solana_swap_reservations x WHERE x.owner_id=r.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet'))
  OR EXISTS(SELECT 1 FROM solana_execution_reservations x WHERE x.owner_id=r.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_root_current_5_busy_0 BEFORE INSERT ON wallet_warmup_execution_roots BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM pair_order_executions e WHERE e.owner_id=c.owner_id
  AND e.wallet=json_extract(selected.value,'$.wallet') AND e.state IN ('reserved','signed','submitting','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_root_current_5_busy_1 BEFORE INSERT ON wallet_warmup_execution_roots BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM imported_swap_signing_intents i WHERE i.owner_id=c.owner_id
  AND i.wallet_address=json_extract(selected.value,'$.wallet') AND i.state IN ('awaiting_signature','signed','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_root_current_5_busy_2 BEFORE INSERT ON wallet_warmup_execution_roots BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM warmup_signing_intents i WHERE i.owner_id=c.owner_id
  AND i.wallet_address=json_extract(selected.value,'$.wallet') AND i.state IN ('awaiting_signature','signed','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_root_current_5_busy_3 BEFORE INSERT ON wallet_warmup_execution_roots BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM pump_launch_reviews r WHERE r.owner_id=c.owner_id
  AND r.state NOT IN ('cancelled','failed','finalized') AND (r.payer=json_extract(selected.value,'$.wallet')
   OR EXISTS(SELECT 1 FROM json_each(r.review,'$.input.holders') h
    WHERE json_extract(r.review,'$.format') IN ('pump-create-holders-review-v1','pump-launch-group-review-v1')
    AND json_extract(h.value,'$.kind')!='none' AND json_extract(h.value,'$.address')=json_extract(selected.value,'$.wallet'))))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_root_current_5_busy_4 BEFORE INSERT ON wallet_warmup_execution_roots BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM volume_bot_sessions s,json_each(s.plan,'$.wallets') w
  WHERE s.owner_id=c.owner_id AND w.value=json_extract(selected.value,'$.wallet')
  AND (s.state='active' OR EXISTS(SELECT 1 FROM volume_bot_batches batch JOIN volume_bot_trades t ON t.batch_id=batch.id
   WHERE batch.session_id=s.id AND t.state IN ('signed','submitting','submitted'))))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_root_current_5_busy_5 BEFORE INSERT ON wallet_warmup_execution_roots BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM volume_bundle_reservations b WHERE b.owner_id=c.owner_id
  AND b.wallet=json_extract(selected.value,'$.wallet') AND b.state IN ('held','attempted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_root_current_5_busy_6 BEFORE INSERT ON wallet_warmup_execution_roots BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM pump_organic_sequences s,json_each(s.plan,'$.rows') w
  WHERE s.owner_id=c.owner_id AND json_extract(w.value,'$.address')=json_extract(selected.value,'$.wallet')
  AND (s.state='active' OR EXISTS(SELECT 1 FROM pump_organic_batches batch JOIN pump_organic_buys t ON t.batch_id=batch.id
   WHERE batch.sequence_id=s.id AND t.state IN ('signed','submitting','submitted'))))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_root_current_5_busy_7 BEFORE INSERT ON wallet_warmup_execution_roots BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM wallet_cleanups x WHERE x.owner_id=c.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet')
  AND x.state IN ('awaiting_signature','signing','signed','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_root_current_5_busy_8 BEFORE INSERT ON wallet_warmup_execution_roots BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM token_supply_actions x WHERE x.owner_id=c.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet')
  AND x.state IN ('awaiting_signature','signing','signed','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_root_current_5_busy_9 BEFORE INSERT ON wallet_warmup_execution_roots BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM sniper_nuke_sells x WHERE x.owner_id=c.owner_id AND x.wallet=json_extract(selected.value,'$.wallet')
  AND x.state IN ('review','signed','submitting','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_root_current_5_busy_10 BEFORE INSERT ON wallet_warmup_execution_roots BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM counter_proposal_reservations x WHERE x.owner_id=c.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet')
  AND (x.approval_id IS NOT NULL OR x.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_root_current_6 BEFORE INSERT ON wallet_warmup_execution_roots BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND ((SELECT count(*) FROM warmup_buy_receipts b WHERE b.owner_id=r.owner_id AND b.plan_id=r.plan_id)=json_array_length(r.source,'$.buys'))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_root_current_7 BEFORE INSERT ON wallet_warmup_execution_roots BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM json_each(r.source,'$.buys') j WHERE NOT EXISTS(
  SELECT 1 FROM warmup_buy_receipts b WHERE b.owner_id=r.owner_id AND b.plan_id=r.plan_id AND (b.id) IS json_extract(j.value,'$.id') AND (b.plan_revision) IS json_extract(j.value,'$.planRevision') AND (b.wallet_revision) IS json_extract(j.value,'$.walletRevision') AND (b.cycle) IS json_extract(j.value,'$.cycle') AND (b.wallet_address) IS json_extract(j.value,'$.wallet') AND (b.document) IS json_extract(j.value,'$.document') AND (json_extract(b.document,'$.mint')) IS json_extract(j.value,'$.mint') AND (json_extract(b.document,'$.acquiredRaw')) IS json_extract(j.value,'$.acquiredRaw') AND (COALESCE(b.remaining_raw,json_extract(b.document,'$.acquiredRaw'))) IS json_extract(j.value,'$.remainingRaw') AND (json_extract(b.document,'$.decimals')) IS json_extract(j.value,'$.decimals') AND ( CASE WHEN json_extract(b.document,'$.signatureVerified')=1 AND json_extract(b.document,'$.wallet')=b.wallet_address AND json_extract(b.document,'$.signature')=b.signature THEN 1 ELSE 0 END) IS json_extract(j.value,'$.verified') AND (json_extract(b.document,'$.commitment')) IS json_extract(j.value,'$.commitment') AND (json_extract(b.document,'$.network')) IS json_extract(j.value,'$.network'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_root_current_8 BEFORE INSERT ON wallet_warmup_execution_roots BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND ((SELECT count(*) FROM warmup_sell_receipts s WHERE s.owner_id=r.owner_id AND s.plan_id=r.plan_id)=json_array_length(r.source,'$.sells'))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_root_current_9 BEFORE INSERT ON wallet_warmup_execution_roots BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM json_each(r.source,'$.sells') j WHERE NOT EXISTS(
  SELECT 1 FROM warmup_sell_receipts s WHERE s.owner_id=r.owner_id AND s.plan_id=r.plan_id AND (s.id) IS json_extract(j.value,'$.id') AND (s.document) IS json_extract(j.value,'$.document') AND (s.buy_receipt_id) IS json_extract(j.value,'$.buyId') AND (s.consumed_raw) IS json_extract(j.value,'$.consumedRaw') AND ( CASE WHEN json_extract(s.document,'$.signatureVerified')=1 AND json_extract(s.document,'$.signature')=s.signature AND json_extract(s.document,'$.consumedRaw')=s.consumed_raw AND json_extract(s.document,'$.buyReceiptId')=s.buy_receipt_id THEN 1 ELSE 0 END) IS json_extract(j.value,'$.verified') AND (json_extract(s.document,'$.commitment')) IS json_extract(j.value,'$.commitment') AND (json_extract(s.document,'$.network')) IS json_extract(j.value,'$.network'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
