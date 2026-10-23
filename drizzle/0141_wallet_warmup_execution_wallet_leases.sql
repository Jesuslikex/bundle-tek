CREATE TABLE wallet_warmup_execution_wallet_leases (
 owner_id TEXT NOT NULL, proposal_id TEXT NOT NULL, consent_id TEXT NOT NULL, review_id TEXT NOT NULL,
 header_sha256 TEXT NOT NULL, terms_sha256 TEXT NOT NULL, consent_sha256 TEXT NOT NULL,
 root_sha256 TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, root_created_at TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,proposal_id), UNIQUE(owner_id,root_sha256),
 FOREIGN KEY(owner_id,proposal_id) REFERENCES wallet_warmup_execution_roots(owner_id,proposal_id)
);
--> statement-breakpoint
CREATE VIEW wallet_warmup_execution_held_wallets AS
 SELECT l.owner_id,l.proposal_id,l.root_sha256,json_extract(w.value,'$.wallet') AS wallet_address,
 json_extract(w.value,'$.walletRevision') AS wallet_revision
 FROM wallet_warmup_execution_wallet_leases l
 JOIN wallet_warmup_execution_roots r ON r.owner_id=l.owner_id AND r.proposal_id=l.proposal_id
 JOIN wallet_warmup_session_reviews v ON v.owner_id=r.owner_id AND v.id=r.review_id
 JOIN json_each(v.document,'$.wallets') w;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_shape_0 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT RAISE(ABORT,'Exact warmup wallet lease refused') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_wallet_leases x WHERE x.owner_id=NEW.owner_id AND (x.proposal_id=NEW.proposal_id OR x.root_sha256=NEW.root_sha256));
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_shape_1 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT RAISE(ABORT,'Exact warmup wallet lease refused') WHERE NEW.created_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_shape_2 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT RAISE(ABORT,'Exact warmup wallet lease refused') WHERE strftime('%Y-%m-%dT%H:%M:%fZ',NEW.root_created_at) IS NOT NEW.root_created_at;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_shape_3 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT RAISE(ABORT,'Exact warmup wallet lease refused') WHERE (length(NEW.header_sha256)!=64 OR NEW.header_sha256 GLOB '*[^a-f0-9]*');
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_shape_4 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT RAISE(ABORT,'Exact warmup wallet lease refused') WHERE (length(NEW.terms_sha256)!=64 OR NEW.terms_sha256 GLOB '*[^a-f0-9]*');
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_shape_5 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT RAISE(ABORT,'Exact warmup wallet lease refused') WHERE (length(NEW.consent_sha256)!=64 OR NEW.consent_sha256 GLOB '*[^a-f0-9]*');
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_shape_6 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT RAISE(ABORT,'Exact warmup wallet lease refused') WHERE (length(NEW.root_sha256)!=64 OR NEW.root_sha256 GLOB '*[^a-f0-9]*');
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_shape_7 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT RAISE(ABORT,'Exact warmup wallet lease refused') WHERE (length(NEW.manifest_sha256)!=64 OR NEW.manifest_sha256 GLOB '*[^a-f0-9]*');
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_identity BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT RAISE(ABORT,'Exact warmup wallet lease refused') WHERE NOT EXISTS(
 SELECT 1 FROM wallet_warmup_execution_roots r
 JOIN wallet_warmup_execution_approvals a ON a.owner_id=r.owner_id AND a.proposal_id=r.proposal_id
 JOIN wallet_warmup_execution_proposal_stages ps ON ps.owner_id=r.owner_id AND ps.id=r.proposal_id
 JOIN wallet_warmup_execution_proposal_publications pp ON pp.owner_id=r.owner_id AND pp.proposal_id=r.proposal_id
 JOIN wallet_warmup_session_reviews rv ON rv.owner_id=r.owner_id AND rv.id=r.review_id
 WHERE r.owner_id=NEW.owner_id AND r.proposal_id=NEW.proposal_id AND r.consent_id=NEW.consent_id AND r.review_id=NEW.review_id
 AND r.header_sha256=NEW.header_sha256 AND r.terms_sha256=NEW.terms_sha256 AND r.consent_sha256=NEW.consent_sha256
 AND r.root_sha256=NEW.root_sha256 AND r.manifest_sha256=NEW.manifest_sha256 AND r.created_at=NEW.root_created_at
 AND a.consent_id=r.consent_id AND a.review_id=r.review_id AND a.header_sha256=r.header_sha256 AND a.terms_sha256=r.terms_sha256
 AND ps.consent_id=r.consent_id AND ps.review_id=r.review_id AND ps.header_sha256=r.header_sha256
 AND json_extract(ps.header,'$.termsSha256')=r.terms_sha256 AND pp.header_sha256=r.header_sha256 AND rv.review_sha256=ps.review_sha256
 AND NEW.created_at>=r.created_at AND NEW.created_at>=a.approved_at AND NEW.created_at>=pp.published_at
 AND NEW.created_at<ps.expires_at AND NEW.created_at<a.pacing_before AND NEW.created_at<a.session_expires_at AND NEW.created_at<rv.review_expires_at);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_no_update BEFORE UPDATE ON wallet_warmup_execution_wallet_leases BEGIN SELECT RAISE(ABORT,'Warmup wallet leases are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_no_delete BEFORE DELETE ON wallet_warmup_execution_wallet_leases BEGIN SELECT RAISE(ABORT,'Warmup wallet leases are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_current_0 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (strftime('%Y-%m-%dT%H:%M:%fZ','now')>=r.reviewed_at)) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_current_1 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (strftime('%Y-%m-%dT%H:%M:%fZ','now')>=r.created_at)) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_current_2 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (strftime('%Y-%m-%dT%H:%M:%fZ','now')<r.review_expires_at)) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_current_3 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (EXISTS(SELECT 1 FROM wallet_warmup_plans p WHERE p.owner_id=r.owner_id AND p.id=r.plan_id
  AND p.revision=r.plan_revision AND p.archived=0 AND json_extract(p.document,'$.chain')='Solana'
  AND p.document=json_extract(r.source,'$.planDocument') AND p.updated_at=json_extract(r.source,'$.planUpdatedAt')))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_current_4 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM json_each(r.document,'$.wallets') selected
  WHERE NOT EXISTS(SELECT 1 FROM workspace_wallets w WHERE w.owner_id=r.owner_id AND w.chain='Solana'
   AND w.address=json_extract(selected.value,'$.wallet') AND w.revision=json_extract(selected.value,'$.walletRevision') AND w.archived=0)
  OR EXISTS(SELECT 1 FROM solana_swap_reservations x WHERE x.owner_id=r.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet'))
  OR EXISTS(SELECT 1 FROM solana_execution_reservations x WHERE x.owner_id=r.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_current_5_busy_0 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM pair_order_executions e WHERE e.owner_id=c.owner_id
  AND e.wallet=json_extract(selected.value,'$.wallet') AND e.state IN ('reserved','signed','submitting','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_current_5_busy_1 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM imported_swap_signing_intents i WHERE i.owner_id=c.owner_id
  AND i.wallet_address=json_extract(selected.value,'$.wallet') AND i.state IN ('awaiting_signature','signed','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_current_5_busy_2 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM warmup_signing_intents i WHERE i.owner_id=c.owner_id
  AND i.wallet_address=json_extract(selected.value,'$.wallet') AND i.state IN ('awaiting_signature','signed','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_current_5_busy_3 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM pump_launch_reviews r WHERE r.owner_id=c.owner_id
  AND r.state NOT IN ('cancelled','failed','finalized') AND (r.payer=json_extract(selected.value,'$.wallet')
   OR EXISTS(SELECT 1 FROM json_each(r.review,'$.input.holders') h
    WHERE json_extract(r.review,'$.format') IN ('pump-create-holders-review-v1','pump-launch-group-review-v1')
    AND json_extract(h.value,'$.kind')!='none' AND json_extract(h.value,'$.address')=json_extract(selected.value,'$.wallet'))))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_current_5_busy_4 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM volume_bot_sessions s,json_each(s.plan,'$.wallets') w
  WHERE s.owner_id=c.owner_id AND w.value=json_extract(selected.value,'$.wallet')
  AND (s.state='active' OR EXISTS(SELECT 1 FROM volume_bot_batches batch JOIN volume_bot_trades t ON t.batch_id=batch.id
   WHERE batch.session_id=s.id AND t.state IN ('signed','submitting','submitted'))))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_current_5_busy_5 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM volume_bundle_reservations b WHERE b.owner_id=c.owner_id
  AND b.wallet=json_extract(selected.value,'$.wallet') AND b.state IN ('held','attempted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_current_5_busy_6 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM pump_organic_sequences s,json_each(s.plan,'$.rows') w
  WHERE s.owner_id=c.owner_id AND json_extract(w.value,'$.address')=json_extract(selected.value,'$.wallet')
  AND (s.state='active' OR EXISTS(SELECT 1 FROM pump_organic_batches batch JOIN pump_organic_buys t ON t.batch_id=batch.id
   WHERE batch.sequence_id=s.id AND t.state IN ('signed','submitting','submitted'))))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_current_5_busy_7 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM wallet_cleanups x WHERE x.owner_id=c.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet')
  AND x.state IN ('awaiting_signature','signing','signed','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_current_5_busy_8 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM token_supply_actions x WHERE x.owner_id=c.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet')
  AND x.state IN ('awaiting_signature','signing','signed','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_current_5_busy_9 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM sniper_nuke_sells x WHERE x.owner_id=c.owner_id AND x.wallet=json_extract(selected.value,'$.wallet')
  AND x.state IN ('review','signed','submitting','submitted'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_current_5_busy_10 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE EXISTS(SELECT 1 FROM counter_proposal_reservations x WHERE x.owner_id=c.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet')
  AND (x.approval_id IS NOT NULL OR x.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_current_6 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND ((SELECT count(*) FROM warmup_buy_receipts b WHERE b.owner_id=r.owner_id AND b.plan_id=r.plan_id)=json_array_length(r.source,'$.buys'))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_current_7 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM json_each(r.source,'$.buys') j WHERE NOT EXISTS(
  SELECT 1 FROM warmup_buy_receipts b WHERE b.owner_id=r.owner_id AND b.plan_id=r.plan_id AND (b.id) IS json_extract(j.value,'$.id') AND (b.plan_revision) IS json_extract(j.value,'$.planRevision') AND (b.wallet_revision) IS json_extract(j.value,'$.walletRevision') AND (b.cycle) IS json_extract(j.value,'$.cycle') AND (b.wallet_address) IS json_extract(j.value,'$.wallet') AND (b.document) IS json_extract(j.value,'$.document') AND (json_extract(b.document,'$.mint')) IS json_extract(j.value,'$.mint') AND (json_extract(b.document,'$.acquiredRaw')) IS json_extract(j.value,'$.acquiredRaw') AND (COALESCE(b.remaining_raw,json_extract(b.document,'$.acquiredRaw'))) IS json_extract(j.value,'$.remainingRaw') AND (json_extract(b.document,'$.decimals')) IS json_extract(j.value,'$.decimals') AND ( CASE WHEN json_extract(b.document,'$.signatureVerified')=1 AND json_extract(b.document,'$.wallet')=b.wallet_address AND json_extract(b.document,'$.signature')=b.signature THEN 1 ELSE 0 END) IS json_extract(j.value,'$.verified') AND (json_extract(b.document,'$.commitment')) IS json_extract(j.value,'$.commitment') AND (json_extract(b.document,'$.network')) IS json_extract(j.value,'$.network'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_current_8 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND ((SELECT count(*) FROM warmup_sell_receipts s WHERE s.owner_id=r.owner_id AND s.plan_id=r.plan_id)=json_array_length(r.source,'$.sells'))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_current_9 BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id AND (NOT EXISTS(SELECT 1 FROM json_each(r.source,'$.sells') j WHERE NOT EXISTS(
  SELECT 1 FROM warmup_sell_receipts s WHERE s.owner_id=r.owner_id AND s.plan_id=r.plan_id AND (s.id) IS json_extract(j.value,'$.id') AND (s.document) IS json_extract(j.value,'$.document') AND (s.buy_receipt_id) IS json_extract(j.value,'$.buyId') AND (s.consumed_raw) IS json_extract(j.value,'$.consumedRaw') AND ( CASE WHEN json_extract(s.document,'$.signatureVerified')=1 AND json_extract(s.document,'$.signature')=s.signature AND json_extract(s.document,'$.consumedRaw')=s.consumed_raw AND json_extract(s.document,'$.buyReceiptId')=s.buy_receipt_id THEN 1 ELSE 0 END) IS json_extract(j.value,'$.verified') AND (json_extract(s.document,'$.commitment')) IS json_extract(j.value,'$.commitment') AND (json_extract(s.document,'$.network')) IS json_extract(j.value,'$.network'))))) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_unresolved BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(
 SELECT 1 FROM (SELECT r.owner_id,r.document AS review_document FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id) c
 WHERE (CASE WHEN EXISTS (
 SELECT 1 FROM json_each(c.review_document,'$.wallets') selected
 WHERE EXISTS (
  SELECT 1 FROM volume_bot_trades t
  LEFT JOIN volume_bot_batches b ON b.id=t.batch_id
  LEFT JOIN volume_bot_sessions s ON s.id=b.session_id
  WHERE t.wallet=json_extract(selected.value,'$.wallet')
   AND t.state IN ('signed','submitting','submitted')
   AND (t.owner_id=c.owner_id OR b.owner_id=c.owner_id OR s.owner_id=c.owner_id)
 ) OR EXISTS (
  SELECT 1 FROM pump_organic_buys t
  LEFT JOIN pump_organic_batches b ON b.id=t.batch_id
  LEFT JOIN pump_organic_sequences s ON s.id=b.sequence_id
  WHERE t.holder=json_extract(selected.value,'$.wallet')
   AND t.state IN ('signed','submitting','submitted')
   AND (t.owner_id=c.owner_id OR b.owner_id=c.owner_id OR s.owner_id=c.owner_id)
 )
) THEN 1 ELSE 0 END)!=0);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_admit_withdrawal BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r,json_each(r.document,'$.wallets') w JOIN native_withdrawals x ON x.owner_id=r.owner_id AND x.wallet_address=json_extract(w.value,'$.wallet') WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND x.state IN ('awaiting_signature','signing','signed','submitted'));
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_admit_swap BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r,json_each(r.document,'$.wallets') w JOIN solana_swap_reservations x ON x.owner_id=r.owner_id AND x.wallet_address=json_extract(w.value,'$.wallet') WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND x.state IN ('awaiting_signature','signed','submitted'));
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_admit_central BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r,json_each(r.document,'$.wallets') w JOIN solana_execution_reservations x ON x.owner_id=r.owner_id AND x.wallet_address=json_extract(w.value,'$.wallet') WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND x.state IN ('awaiting_signature','signing','signed','submitting','submitted','reserved'));
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_admit_family BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r,json_each(r.document,'$.wallets') w JOIN solana_wallet_family_holds h ON h.owner_id=r.owner_id AND h.wallet_address=json_extract(w.value,'$.wallet') WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_wallet_lease_admit_lease BEFORE INSERT ON wallet_warmup_execution_wallet_leases BEGIN
 SELECT RAISE(ABORT,'Wallet already reserved') WHERE EXISTS(SELECT 1 FROM wallet_warmup_session_reviews r,json_each(r.document,'$.wallets') w JOIN wallet_warmup_execution_held_wallets h ON h.owner_id=r.owner_id AND h.wallet_address=json_extract(w.value,'$.wallet') WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_central_insert BEFORE INSERT ON solana_execution_reservations BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_central_update BEFORE UPDATE ON solana_execution_reservations
WHEN NEW.state IS NULL OR NEW.state NOT IN ('finalized','failed','cancelled')
 OR NEW.owner_id IS NOT OLD.owner_id OR NEW.wallet_address IS NOT OLD.wallet_address
 OR NEW.scope IS NOT OLD.scope OR NEW.intent_id IS NOT OLD.intent_id BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_swap_insert BEFORE INSERT ON solana_swap_reservations BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_swap_update BEFORE UPDATE ON solana_swap_reservations BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_imported_insert BEFORE INSERT ON imported_swap_signing_intents
WHEN NEW.state IN ('awaiting_signature','signed','submitted') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_imported_update BEFORE UPDATE ON imported_swap_signing_intents
WHEN NEW.state IN ('awaiting_signature','signed','submitted') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_warmup_insert BEFORE INSERT ON warmup_signing_intents
WHEN NEW.state IN ('awaiting_signature','signed','submitted') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_warmup_update BEFORE UPDATE ON warmup_signing_intents
WHEN NEW.state IN ('awaiting_signature','signed','submitted') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_withdrawal_insert BEFORE INSERT ON native_withdrawals
WHEN NEW.state IN ('awaiting_signature','signing','signed','submitted') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_withdrawal_update BEFORE UPDATE ON native_withdrawals
WHEN NEW.state IN ('awaiting_signature','signing','signed','submitted') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_pair_insert BEFORE INSERT ON pair_order_executions
WHEN NEW.state IN ('reserved','signed','submitting','submitted') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_pair_update BEFORE UPDATE ON pair_order_executions
WHEN NEW.state IN ('reserved','signed','submitting','submitted') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_nuke_insert BEFORE INSERT ON sniper_nuke_sells
WHEN NEW.state IN ('review','signed','submitting','submitted') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_nuke_update BEFORE UPDATE ON sniper_nuke_sells
WHEN NEW.state IN ('review','signed','submitting','submitted') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_volume_bundle_insert BEFORE INSERT ON volume_bundle_reservations
WHEN NEW.state IN ('held','attempted') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_volume_bundle_update BEFORE UPDATE ON volume_bundle_reservations
WHEN NEW.state IN ('held','attempted') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_cleanup_insert BEFORE INSERT ON wallet_cleanups
WHEN NEW.state IN ('awaiting_signature','signing','signed','submitted') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_cleanup_update BEFORE UPDATE ON wallet_cleanups
WHEN NEW.state IN ('awaiting_signature','signing','signed','submitted') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_supply_insert BEFORE INSERT ON token_supply_actions
WHEN NEW.state IN ('awaiting_signature','signing','signed','submitted') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_supply_update BEFORE UPDATE ON token_supply_actions
WHEN NEW.state IN ('awaiting_signature','signing','signed','submitted') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_counter_insert BEFORE INSERT ON counter_proposal_reservations
WHEN NEW.approval_id IS NOT NULL OR NEW.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_counter_update BEFORE UPDATE ON counter_proposal_reservations
WHEN NEW.approval_id IS NOT NULL OR NEW.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_launch_insert BEFORE INSERT ON pump_launch_reviews
WHEN NEW.state NOT IN ('cancelled','failed','finalized') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND (h.wallet_address=NEW.payer OR EXISTS(SELECT 1 FROM json_each(NEW.review,'$.input.holders') w WHERE json_extract(NEW.review,'$.format') IN ('pump-create-holders-review-v1','pump-launch-group-review-v1') AND json_extract(w.value,'$.kind')!='none' AND json_extract(w.value,'$.address')=h.wallet_address)));
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_launch_update BEFORE UPDATE ON pump_launch_reviews
WHEN NEW.state NOT IN ('cancelled','failed','finalized') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h WHERE h.owner_id=NEW.owner_id AND (h.wallet_address=NEW.payer OR EXISTS(SELECT 1 FROM json_each(NEW.review,'$.input.holders') w WHERE json_extract(NEW.review,'$.format') IN ('pump-create-holders-review-v1','pump-launch-group-review-v1') AND json_extract(w.value,'$.kind')!='none' AND json_extract(w.value,'$.address')=h.wallet_address)));
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_volume_parent_insert BEFORE INSERT ON volume_bot_sessions
WHEN NEW.state='active' BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h,json_each(NEW.plan,'$.wallets') w WHERE h.owner_id=NEW.owner_id AND h.wallet_address=w.value);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_volume_parent_update BEFORE UPDATE ON volume_bot_sessions
WHEN NEW.state='active' BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h,json_each(NEW.plan,'$.wallets') w WHERE h.owner_id=NEW.owner_id AND h.wallet_address=w.value);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_volume_batch_insert BEFORE INSERT ON volume_bot_batches
WHEN NEW.state IN ('review','signed') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM volume_bot_sessions s,json_each(s.plan,'$.wallets') w JOIN wallet_warmup_execution_held_wallets h ON h.wallet_address=w.value WHERE s.id=NEW.session_id AND (h.owner_id=NEW.owner_id OR h.owner_id=s.owner_id));
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_volume_batch_update BEFORE UPDATE ON volume_bot_batches
WHEN NEW.state IN ('review','signed') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM volume_bot_sessions s,json_each(s.plan,'$.wallets') w JOIN wallet_warmup_execution_held_wallets h ON h.wallet_address=w.value WHERE s.id=NEW.session_id AND (h.owner_id=NEW.owner_id OR h.owner_id=s.owner_id));
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_volume_child_insert BEFORE INSERT ON volume_bot_trades
WHEN NEW.state IN ('signed','submitting','submitted') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h LEFT JOIN volume_bot_batches b ON b.id=NEW.batch_id LEFT JOIN volume_bot_sessions s ON s.id=b.session_id WHERE h.wallet_address=NEW.wallet AND (h.owner_id=NEW.owner_id OR h.owner_id=b.owner_id OR h.owner_id=s.owner_id));
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_volume_child_update BEFORE UPDATE ON volume_bot_trades
WHEN NEW.state IN ('signed','submitting','submitted') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h LEFT JOIN volume_bot_batches b ON b.id=NEW.batch_id LEFT JOIN volume_bot_sessions s ON s.id=b.session_id WHERE h.wallet_address=NEW.wallet AND (h.owner_id=NEW.owner_id OR h.owner_id=b.owner_id OR h.owner_id=s.owner_id));
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_organic_parent_insert BEFORE INSERT ON pump_organic_sequences
WHEN NEW.state='active' BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h,json_each(NEW.plan,'$.rows') w WHERE h.owner_id=NEW.owner_id AND h.wallet_address=json_extract(w.value,'$.address'));
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_organic_parent_update BEFORE UPDATE ON pump_organic_sequences
WHEN NEW.state='active' BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h,json_each(NEW.plan,'$.rows') w WHERE h.owner_id=NEW.owner_id AND h.wallet_address=json_extract(w.value,'$.address'));
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_organic_batch_insert BEFORE INSERT ON pump_organic_batches
WHEN NEW.state IN ('review','signed') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM pump_organic_sequences s,json_each(s.plan,'$.rows') w JOIN wallet_warmup_execution_held_wallets h ON h.wallet_address=json_extract(w.value,'$.address') WHERE s.id=NEW.sequence_id AND (h.owner_id=NEW.owner_id OR h.owner_id=s.owner_id));
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_organic_batch_update BEFORE UPDATE ON pump_organic_batches
WHEN NEW.state IN ('review','signed') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM pump_organic_sequences s,json_each(s.plan,'$.rows') w JOIN wallet_warmup_execution_held_wallets h ON h.wallet_address=json_extract(w.value,'$.address') WHERE s.id=NEW.sequence_id AND (h.owner_id=NEW.owner_id OR h.owner_id=s.owner_id));
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_organic_child_insert BEFORE INSERT ON pump_organic_buys
WHEN NEW.state IN ('signed','submitting','submitted') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h LEFT JOIN pump_organic_batches b ON b.id=NEW.batch_id LEFT JOIN pump_organic_sequences s ON s.id=b.sequence_id WHERE h.wallet_address=NEW.holder AND (h.owner_id=NEW.owner_id OR h.owner_id=b.owner_id OR h.owner_id=s.owner_id));
END;
--> statement-breakpoint
CREATE TRIGGER warmup_lease_blocks_organic_child_update BEFORE UPDATE ON pump_organic_buys
WHEN NEW.state IN ('signed','submitting','submitted') BEGIN
 SELECT RAISE(ABORT,'Wallet held by warmup execution') WHERE EXISTS(SELECT 1 FROM wallet_warmup_execution_held_wallets h LEFT JOIN pump_organic_batches b ON b.id=NEW.batch_id LEFT JOIN pump_organic_sequences s ON s.id=b.sequence_id WHERE h.wallet_address=NEW.holder AND (h.owner_id=NEW.owner_id OR h.owner_id=b.owner_id OR h.owner_id=s.owner_id));
END;
