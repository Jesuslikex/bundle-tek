CREATE TABLE wallet_warmup_session_action_bindings (
 owner_id TEXT NOT NULL,journal_id TEXT NOT NULL,action_id TEXT NOT NULL,
 preparation_id TEXT NOT NULL,preparation_document TEXT NOT NULL CHECK(json_valid(preparation_document)),
 packet_sha256 TEXT NOT NULL,review_version INTEGER NOT NULL,review_sha256 TEXT NOT NULL,
 created_at TEXT NOT NULL,binding_sha256 TEXT NOT NULL,
 PRIMARY KEY(owner_id,journal_id,action_id),UNIQUE(owner_id,preparation_id),UNIQUE(owner_id,packet_sha256),UNIQUE(owner_id,journal_id,review_version),
 FOREIGN KEY(owner_id,journal_id) REFERENCES wallet_warmup_session_journals(owner_id,id)
);
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_action_bindings_insert BEFORE INSERT ON wallet_warmup_session_action_bindings BEGIN
 SELECT CASE WHEN length(NEW.binding_sha256)!=64 OR NEW.binding_sha256 GLOB '*[^a-f0-9]*'
 OR length(NEW.packet_sha256)!=64 OR NEW.packet_sha256 GLOB '*[^a-f0-9]*'
 OR length(NEW.review_sha256)!=64 OR NEW.review_sha256 GLOB '*[^a-f0-9]*'
 OR length(CAST(NEW.preparation_document AS BLOB))>8192
 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) IS NOT NEW.created_at
 OR EXISTS(SELECT 1 FROM wallet_warmup_session_action_bindings b WHERE b.owner_id=NEW.owner_id AND (b.preparation_id=NEW.preparation_id OR b.packet_sha256=NEW.packet_sha256 OR (b.journal_id=NEW.journal_id AND (b.action_id=NEW.action_id OR b.review_version=NEW.review_version))))
 OR EXISTS(SELECT 1 FROM warmup_signing_intents i WHERE i.owner_id=NEW.owner_id AND i.preparation_id=NEW.preparation_id)
 OR EXISTS(SELECT 1 FROM warmup_buy_receipts r WHERE r.owner_id=NEW.owner_id AND r.preparation_id=NEW.preparation_id)
 OR EXISTS(SELECT 1 FROM warmup_sell_receipts r WHERE r.owner_id=NEW.owner_id AND r.preparation_id=NEW.preparation_id)
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_session_journals j
 JOIN wallet_warmup_session_journal_heads h ON h.owner_id=j.owner_id AND h.journal_id=j.id
 JOIN wallet_warmup_session_journal_events e ON e.owner_id=j.owner_id AND e.journal_id=j.id AND e.version=h.version
 JOIN warmup_swap_preparations p ON p.owner_id=j.owner_id AND p.id=NEW.preparation_id
 JOIN wallet_warmup_plans plan ON plan.owner_id=j.owner_id AND plan.id=p.plan_id,
 json_each(j.source_document,'$.review.actions') a
 WHERE j.owner_id=NEW.owner_id AND j.id=NEW.journal_id
 AND h.version=NEW.review_version AND h.head_sha256=NEW.review_sha256
 AND e.event_sha256=NEW.review_sha256 AND json_extract(e.document,'$.operation')='begin-review'
 AND json_extract(e.document,'$.actionId')=NEW.action_id AND json_extract(a.value,'$.id')=NEW.action_id
 AND NEW.created_at>=e.created_at AND NEW.created_at<json_extract(j.source_document,'$.reviewExpiresAt')
 AND strftime('%Y-%m-%dT%H:%M:%fZ',p.created_at)=p.created_at AND p.created_at>=e.created_at AND p.created_at<=NEW.created_at
 AND p.document=NEW.preparation_document AND json_extract(p.document,'$.transaction.sha256')=NEW.packet_sha256
 AND p.plan_id=json_extract(j.source_document,'$.review.planId') AND p.plan_revision=json_extract(j.source_document,'$.review.planRevision')
 AND plan.revision=p.plan_revision AND plan.archived=0
 AND EXISTS(SELECT 1 FROM wallet_warmup_session_consents c JOIN wallet_warmup_session_reviews r ON r.owner_id=c.owner_id AND r.id=c.review_id
 WHERE c.owner_id=j.owner_id AND c.id=j.consent_id AND plan.document=json_extract(r.source,'$.planDocument') AND plan.updated_at=json_extract(r.source,'$.planUpdatedAt'))
 AND p.cycle=json_extract(a.value,'$.cycle') AND p.wallet_revision=json_extract(a.value,'$.walletRevision')
 AND p.wallet_address=json_extract(a.value,'$.wallet') AND json_extract(p.document,'$.wallet')=p.wallet_address
 AND EXISTS(SELECT 1 FROM workspace_wallets w WHERE w.owner_id=NEW.owner_id AND w.chain='Solana' AND w.address=p.wallet_address AND w.revision=p.wallet_revision AND w.archived=0)
 AND json_extract(p.document,'$.side')=json_extract(a.value,'$.side')
 AND ((json_extract(a.value,'$.side')='Buy'
 AND json_extract(p.document,'$.inputMint')='So11111111111111111111111111111111111111112'
 AND json_extract(p.document,'$.outputMint')=json_extract(a.value,'$.mint')
 AND json_extract(p.document,'$.inAmountRaw')=json_extract(a.value,'$.inputLamports'))
 OR (json_extract(a.value,'$.side')='Sell'
 AND json_extract(p.document,'$.outputMint')='So11111111111111111111111111111111111111112'
 AND json_extract(p.document,'$.inputMint')=json_extract(a.value,'$.mint')
 AND ((json_extract(a.value,'$.source.kind')='saved-buy'
 AND json_extract(p.document,'$.buyReceipt.receiptId')=json_extract(a.value,'$.source.buyReceiptId')
 AND json_extract(p.document,'$.inAmountRaw')=json_extract(a.value,'$.source.remainingRaw'))
 OR (json_extract(a.value,'$.source.kind')='session-buy'
 AND EXISTS(SELECT 1 FROM wallet_warmup_session_settlements s WHERE s.owner_id=NEW.owner_id AND s.journal_id=NEW.journal_id AND s.action_id=json_extract(a.value,'$.source.actionId') AND s.side='Buy' AND s.mode='applied'
 AND json_extract(p.document,'$.buyReceipt.receiptId')=s.receipt_id
 AND json_extract(p.document,'$.inAmountRaw')=json_extract(s.document,'$.settlement.acquiredRaw')))))))
 THEN RAISE(ABORT,'Exact unsigned action binding refused') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_action_bindings_no_update BEFORE UPDATE ON wallet_warmup_session_action_bindings BEGIN SELECT RAISE(ABORT,'Action bindings are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_action_bindings_no_delete BEFORE DELETE ON wallet_warmup_session_action_bindings BEGIN SELECT RAISE(ABORT,'Action bindings are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_settlements_action_binding BEFORE INSERT ON wallet_warmup_session_settlements BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_action_bindings b
 WHERE b.owner_id=NEW.owner_id AND b.journal_id=NEW.journal_id AND b.action_id=NEW.action_id
 AND b.preparation_id=json_extract(NEW.source,'$[0].preparationId')
 AND b.preparation_document=json_extract(NEW.source,'$[0].preparationDocument')
 AND b.packet_sha256=json_extract(json_extract(NEW.source,'$[0].preparationDocument'),'$.transaction.sha256')
 AND b.created_at<=NEW.created_at AND b.review_version<json_extract(NEW.document,'$.version'))
 THEN RAISE(ABORT,'Settlement does not belong to the bound action packet') END;
END;
