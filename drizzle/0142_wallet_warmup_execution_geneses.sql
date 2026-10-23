CREATE TABLE wallet_warmup_execution_geneses (
 owner_id TEXT NOT NULL CHECK(typeof(owner_id)='text' AND length(owner_id) BETWEEN 1 AND 128 AND owner_id NOT GLOB '*[^a-zA-Z0-9_-]*'),
 proposal_id TEXT NOT NULL CHECK(typeof(proposal_id)='text' AND length(proposal_id)=36 AND substr(proposal_id,9,1)='-' AND substr(proposal_id,14,1)='-' AND substr(proposal_id,19,1)='-' AND substr(proposal_id,24,1)='-' AND length(replace(proposal_id,'-',''))=32 AND replace(proposal_id,'-','') NOT GLOB '*[^a-f0-9]*' AND ((substr(proposal_id,15,1) GLOB '[1-8]' AND substr(proposal_id,20,1) GLOB '[89ab]') OR proposal_id='00000000-0000-0000-0000-000000000000' OR proposal_id='ffffffff-ffff-ffff-ffff-ffffffffffff')),
 root_sha256 TEXT NOT NULL CHECK(typeof(root_sha256)='text' AND length(root_sha256)=64 AND root_sha256 NOT GLOB '*[^a-f0-9]*'),
 manifest_sha256 TEXT NOT NULL CHECK(typeof(manifest_sha256)='text' AND length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^a-f0-9]*'),
 lease_created_at TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version=0),
 event_sha256 TEXT NOT NULL CHECK(typeof(event_sha256)='text' AND length(event_sha256)=64 AND event_sha256 NOT GLOB '*[^a-f0-9]*'),
 checkpoint_sha256 TEXT NOT NULL CHECK(typeof(checkpoint_sha256)='text' AND length(checkpoint_sha256)=64 AND checkpoint_sha256 NOT GLOB '*[^a-f0-9]*'),
 recorded_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,proposal_id), UNIQUE(owner_id,root_sha256),
 FOREIGN KEY(owner_id,proposal_id) REFERENCES wallet_warmup_execution_wallet_leases(owner_id,proposal_id)
);
--> statement-breakpoint
CREATE TRIGGER warmup_execution_genesis_insert BEFORE INSERT ON wallet_warmup_execution_geneses BEGIN
 SELECT RAISE(ABORT,'Exact warmup execution genesis refused') WHERE
 EXISTS(SELECT 1 FROM wallet_warmup_execution_geneses g WHERE g.owner_id=NEW.owner_id AND (g.proposal_id=NEW.proposal_id OR g.root_sha256=NEW.root_sha256))
 OR NEW.recorded_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.lease_created_at) IS NOT NEW.lease_created_at
 OR NEW.recorded_at<NEW.lease_created_at
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_wallet_leases l
 JOIN wallet_warmup_execution_roots r ON r.owner_id=l.owner_id AND r.proposal_id=l.proposal_id
 WHERE l.owner_id=NEW.owner_id AND l.proposal_id=NEW.proposal_id AND l.root_sha256=NEW.root_sha256
 AND l.manifest_sha256=NEW.manifest_sha256 AND l.created_at=NEW.lease_created_at
 AND r.root_sha256=l.root_sha256 AND r.manifest_sha256=l.manifest_sha256 AND r.created_at=l.root_created_at
 AND r.consent_id=l.consent_id AND r.review_id=l.review_id AND r.header_sha256=l.header_sha256
 AND r.terms_sha256=l.terms_sha256 AND r.consent_sha256=l.consent_sha256);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_genesis_no_update BEFORE UPDATE ON wallet_warmup_execution_geneses BEGIN SELECT RAISE(ABORT,'Warmup execution geneses are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_genesis_no_delete BEFORE DELETE ON wallet_warmup_execution_geneses BEGIN SELECT RAISE(ABORT,'Warmup execution geneses are immutable'); END;
