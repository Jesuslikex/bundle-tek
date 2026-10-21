CREATE TABLE wallet_warmup_session_preparations (
 owner_id TEXT NOT NULL,preparation_id TEXT NOT NULL,journal_id TEXT NOT NULL,action_id TEXT NOT NULL,
 review_version INTEGER NOT NULL,review_sha256 TEXT NOT NULL,plan_id TEXT NOT NULL,plan_revision INTEGER NOT NULL,
 cycle INTEGER NOT NULL,wallet_address TEXT NOT NULL,wallet_revision INTEGER NOT NULL,
 preparation_document TEXT NOT NULL CHECK(json_valid(preparation_document)),
 plan_document TEXT NOT NULL CHECK(json_valid(plan_document)),created_at TEXT NOT NULL,binding_sha256 TEXT NOT NULL,record_sha256 TEXT NOT NULL,
 PRIMARY KEY(owner_id,preparation_id),UNIQUE(owner_id,journal_id,action_id),
 FOREIGN KEY(owner_id,journal_id) REFERENCES wallet_warmup_session_journals(owner_id,id)
);
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_preparations_insert BEFORE INSERT ON wallet_warmup_session_preparations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM wallet_warmup_session_preparations p WHERE p.owner_id=NEW.owner_id AND (p.preparation_id=NEW.preparation_id OR (p.journal_id=NEW.journal_id AND p.action_id=NEW.action_id)))
 OR EXISTS(SELECT 1 FROM warmup_swap_preparations p WHERE p.id=NEW.preparation_id)
 OR length(NEW.record_sha256)!=64 OR NEW.record_sha256 GLOB '*[^a-f0-9]*'
 OR length(CAST(NEW.plan_document AS BLOB))>1048576 OR length(CAST(NEW.preparation_document AS BLOB))>8192
 OR (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('wallet_warmup_session_action_bindings_insert','wallet_warmup_session_action_bindings_no_update','wallet_warmup_session_action_bindings_no_delete','wallet_warmup_session_settlements_action_binding','wallet_warmup_session_action_bindings_fresh'))!=5
 THEN RAISE(ABORT,'Session preparation identity changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_preparations_apply AFTER INSERT ON wallet_warmup_session_preparations BEGIN
 INSERT INTO warmup_swap_preparations(id,owner_id,plan_id,plan_revision,cycle,wallet_address,wallet_revision,document,created_at)
 SELECT NEW.preparation_id,NEW.owner_id,NEW.plan_id,NEW.plan_revision,NEW.cycle,NEW.wallet_address,NEW.wallet_revision,NEW.preparation_document,NEW.created_at
 WHERE EXISTS(SELECT 1 FROM wallet_warmup_plans p WHERE p.owner_id=NEW.owner_id AND p.id=NEW.plan_id AND p.revision=NEW.plan_revision AND p.archived=0 AND p.document=NEW.plan_document
 AND (SELECT COUNT(*) FROM json_each(json_extract(p.document,'$.walletRevisions')) j JOIN workspace_wallets w ON w.address=json_extract(j.value,'$.address') AND w.revision=json_extract(j.value,'$.revision') WHERE w.owner_id=p.owner_id AND w.chain=json_extract(p.document,'$.chain') AND w.archived=0)=json_array_length(json_extract(p.document,'$.addresses')))
 AND (SELECT COUNT(*) FROM warmup_swap_preparations WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)<4000
 AND julianday(json_extract(NEW.preparation_document,'$.expiresAt'))>julianday('now');
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'Preparation context changed or history is full') END;
 INSERT INTO wallet_warmup_session_action_bindings(owner_id,journal_id,action_id,preparation_id,preparation_document,packet_sha256,review_version,review_sha256,created_at,binding_sha256)
 VALUES(NEW.owner_id,NEW.journal_id,NEW.action_id,NEW.preparation_id,NEW.preparation_document,json_extract(NEW.preparation_document,'$.transaction.sha256'),NEW.review_version,NEW.review_sha256,NEW.created_at,NEW.binding_sha256);
END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_preparations_no_update BEFORE UPDATE ON wallet_warmup_session_preparations BEGIN SELECT RAISE(ABORT,'Session preparations are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER wallet_warmup_session_preparations_no_delete BEFORE DELETE ON wallet_warmup_session_preparations BEGIN SELECT RAISE(ABORT,'Session preparations are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_session_preparations_no_update BEFORE UPDATE ON warmup_swap_preparations WHEN EXISTS(SELECT 1 FROM wallet_warmup_session_preparations p WHERE p.preparation_id=OLD.id OR p.preparation_id=NEW.id) BEGIN SELECT RAISE(ABORT,'Session preparations are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_session_preparations_no_delete BEFORE DELETE ON warmup_swap_preparations WHEN EXISTS(SELECT 1 FROM wallet_warmup_session_preparations p WHERE p.owner_id=OLD.owner_id AND p.preparation_id=OLD.id) BEGIN SELECT RAISE(ABORT,'Session preparations are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_session_preparations_no_replace BEFORE INSERT ON warmup_swap_preparations WHEN EXISTS(SELECT 1 FROM wallet_warmup_session_preparations p WHERE p.preparation_id=NEW.id) AND EXISTS(SELECT 1 FROM warmup_swap_preparations p WHERE p.id=NEW.id) BEGIN SELECT RAISE(ABORT,'Session preparations are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_session_bound_intents_disabled BEFORE INSERT ON warmup_signing_intents WHEN EXISTS(SELECT 1 FROM wallet_warmup_session_action_bindings b WHERE b.owner_id=NEW.owner_id AND b.preparation_id=NEW.preparation_id) BEGIN SELECT RAISE(ABORT,'Session-bound signing is not enabled'); END;
