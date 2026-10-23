CREATE TABLE wallet_warmup_execution_control_heads (
 owner_id TEXT NOT NULL CHECK(typeof(owner_id)='text' AND length(owner_id) BETWEEN 1 AND 128 AND owner_id NOT GLOB '*[^a-zA-Z0-9_-]*'),
 proposal_id TEXT NOT NULL CHECK(typeof(proposal_id)='text' AND length(proposal_id)=36 AND substr(proposal_id,9,1)='-' AND substr(proposal_id,14,1)='-' AND substr(proposal_id,19,1)='-' AND substr(proposal_id,24,1)='-' AND length(replace(proposal_id,'-',''))=32 AND replace(proposal_id,'-','') NOT GLOB '*[^a-f0-9]*' AND ((substr(proposal_id,15,1) GLOB '[1-8]' AND substr(proposal_id,20,1) GLOB '[89ab]') OR proposal_id='00000000-0000-0000-0000-000000000000' OR proposal_id='ffffffff-ffff-ffff-ffff-ffffffffffff')),
 root_sha256 TEXT NOT NULL CHECK(typeof(root_sha256)='text' AND length(root_sha256)=64 AND root_sha256 NOT GLOB '*[^a-f0-9]*'),
 manifest_sha256 TEXT NOT NULL CHECK(typeof(manifest_sha256)='text' AND length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^a-f0-9]*'),
 lease_created_at TEXT NOT NULL CHECK(typeof(lease_created_at)='text' AND strftime('%Y-%m-%dT%H:%M:%fZ',lease_created_at) IS lease_created_at),
 version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 0 AND 76100),
 event_sha256 TEXT NOT NULL CHECK(typeof(event_sha256)='text' AND length(event_sha256)=64 AND event_sha256 NOT GLOB '*[^a-f0-9]*'),
 checkpoint_sha256 TEXT NOT NULL CHECK(typeof(checkpoint_sha256)='text' AND length(checkpoint_sha256)=64 AND checkpoint_sha256 NOT GLOB '*[^a-f0-9]*'),
 model_at TEXT NOT NULL CHECK(typeof(model_at)='text' AND strftime('%Y-%m-%dT%H:%M:%fZ',model_at) IS model_at),
 recorded_at TEXT NOT NULL CHECK(typeof(recorded_at)='text' AND strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at) IS recorded_at),
 wire_bytes INTEGER NOT NULL CHECK(typeof(wire_bytes)='integer' AND wire_bytes BETWEEN 0 AND 134217728),
 paused INTEGER NOT NULL CHECK(typeof(paused)='integer' AND paused BETWEEN 0 AND 1),
 stopped INTEGER NOT NULL CHECK(typeof(stopped)='integer' AND stopped BETWEEN 0 AND 1),
 PRIMARY KEY(owner_id,proposal_id),
 FOREIGN KEY(owner_id,proposal_id) REFERENCES wallet_warmup_execution_geneses(owner_id,proposal_id)
);
--> statement-breakpoint
CREATE TABLE wallet_warmup_execution_control_intents (
 owner_id TEXT NOT NULL CHECK(typeof(owner_id)='text' AND length(owner_id) BETWEEN 1 AND 128 AND owner_id NOT GLOB '*[^a-zA-Z0-9_-]*'),
 id TEXT NOT NULL CHECK(typeof(id)='text' AND length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND length(replace(id,'-',''))=32 AND replace(id,'-','') NOT GLOB '*[^a-f0-9]*' AND ((substr(id,15,1) GLOB '[1-8]' AND substr(id,20,1) GLOB '[89ab]') OR id='00000000-0000-0000-0000-000000000000' OR id='ffffffff-ffff-ffff-ffff-ffffffffffff')),
 proposal_id TEXT NOT NULL CHECK(typeof(proposal_id)='text' AND length(proposal_id)=36 AND substr(proposal_id,9,1)='-' AND substr(proposal_id,14,1)='-' AND substr(proposal_id,19,1)='-' AND substr(proposal_id,24,1)='-' AND length(replace(proposal_id,'-',''))=32 AND replace(proposal_id,'-','') NOT GLOB '*[^a-f0-9]*' AND ((substr(proposal_id,15,1) GLOB '[1-8]' AND substr(proposal_id,20,1) GLOB '[89ab]') OR proposal_id='00000000-0000-0000-0000-000000000000' OR proposal_id='ffffffff-ffff-ffff-ffff-ffffffffffff')),
 root_sha256 TEXT NOT NULL CHECK(typeof(root_sha256)='text' AND length(root_sha256)=64 AND root_sha256 NOT GLOB '*[^a-f0-9]*'),
 manifest_sha256 TEXT NOT NULL CHECK(typeof(manifest_sha256)='text' AND length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^a-f0-9]*'),
 expected_version INTEGER NOT NULL CHECK(typeof(expected_version)='integer' AND expected_version BETWEEN 0 AND 76099),
 expected_event_sha256 TEXT NOT NULL CHECK(typeof(expected_event_sha256)='text' AND length(expected_event_sha256)=64 AND expected_event_sha256 NOT GLOB '*[^a-f0-9]*'),
 expected_checkpoint_sha256 TEXT NOT NULL CHECK(typeof(expected_checkpoint_sha256)='text' AND length(expected_checkpoint_sha256)=64 AND expected_checkpoint_sha256 NOT GLOB '*[^a-f0-9]*'),
 operation TEXT NOT NULL CHECK(operation IN ('pause','resume','stop')),
 model_at TEXT NOT NULL CHECK(typeof(model_at)='text' AND strftime('%Y-%m-%dT%H:%M:%fZ',model_at) IS model_at),
 PRIMARY KEY(owner_id,id),
 FOREIGN KEY(owner_id,proposal_id) REFERENCES wallet_warmup_execution_control_heads(owner_id,proposal_id)
);
--> statement-breakpoint
CREATE INDEX warmup_execution_control_intents_root ON wallet_warmup_execution_control_intents(owner_id,proposal_id);
--> statement-breakpoint
CREATE TABLE wallet_warmup_execution_control_events (
 owner_id TEXT NOT NULL CHECK(typeof(owner_id)='text' AND length(owner_id) BETWEEN 1 AND 128 AND owner_id NOT GLOB '*[^a-zA-Z0-9_-]*'),
 proposal_id TEXT NOT NULL CHECK(typeof(proposal_id)='text' AND length(proposal_id)=36 AND substr(proposal_id,9,1)='-' AND substr(proposal_id,14,1)='-' AND substr(proposal_id,19,1)='-' AND substr(proposal_id,24,1)='-' AND length(replace(proposal_id,'-',''))=32 AND replace(proposal_id,'-','') NOT GLOB '*[^a-f0-9]*' AND ((substr(proposal_id,15,1) GLOB '[1-8]' AND substr(proposal_id,20,1) GLOB '[89ab]') OR proposal_id='00000000-0000-0000-0000-000000000000' OR proposal_id='ffffffff-ffff-ffff-ffff-ffffffffffff')),
 id TEXT NOT NULL CHECK(typeof(id)='text' AND length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND length(replace(id,'-',''))=32 AND replace(id,'-','') NOT GLOB '*[^a-f0-9]*' AND ((substr(id,15,1) GLOB '[1-8]' AND substr(id,20,1) GLOB '[89ab]') OR id='00000000-0000-0000-0000-000000000000' OR id='ffffffff-ffff-ffff-ffff-ffffffffffff')),
 sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 1 AND 76100),
 root_sha256 TEXT NOT NULL CHECK(typeof(root_sha256)='text' AND length(root_sha256)=64 AND root_sha256 NOT GLOB '*[^a-f0-9]*'),
 manifest_sha256 TEXT NOT NULL CHECK(typeof(manifest_sha256)='text' AND length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^a-f0-9]*'),
 previous_event_sha256 TEXT NOT NULL CHECK(typeof(previous_event_sha256)='text' AND length(previous_event_sha256)=64 AND previous_event_sha256 NOT GLOB '*[^a-f0-9]*'),
 previous_checkpoint_sha256 TEXT NOT NULL CHECK(typeof(previous_checkpoint_sha256)='text' AND length(previous_checkpoint_sha256)=64 AND previous_checkpoint_sha256 NOT GLOB '*[^a-f0-9]*'),
 event_sha256 TEXT NOT NULL CHECK(typeof(event_sha256)='text' AND length(event_sha256)=64 AND event_sha256 NOT GLOB '*[^a-f0-9]*'),
 checkpoint_sha256 TEXT NOT NULL CHECK(typeof(checkpoint_sha256)='text' AND length(checkpoint_sha256)=64 AND checkpoint_sha256 NOT GLOB '*[^a-f0-9]*'),
 operation TEXT NOT NULL CHECK(operation IN ('pause','resume','stop')),
 model_at TEXT NOT NULL CHECK(typeof(model_at)='text' AND strftime('%Y-%m-%dT%H:%M:%fZ',model_at) IS model_at),
 recorded_at TEXT NOT NULL CHECK(typeof(recorded_at)='text' AND strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at) IS recorded_at),
 wire TEXT NOT NULL CHECK(typeof(wire)='text' AND json_valid(wire) AND length(CAST(wire AS BLOB))<=1536),
 PRIMARY KEY(owner_id,proposal_id,sequence),
 UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,id) REFERENCES wallet_warmup_execution_control_intents(owner_id,id),
 FOREIGN KEY(owner_id,proposal_id) REFERENCES wallet_warmup_execution_control_heads(owner_id,proposal_id)
);
--> statement-breakpoint
CREATE TRIGGER warmup_execution_control_head_seed BEFORE INSERT ON wallet_warmup_execution_control_heads BEGIN
 SELECT RAISE(ABORT,'Exact warmup control head refused') WHERE
 EXISTS(SELECT 1 FROM wallet_warmup_execution_control_heads h WHERE h.owner_id=NEW.owner_id AND h.proposal_id=NEW.proposal_id)
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_geneses g WHERE g.owner_id=NEW.owner_id AND g.proposal_id=NEW.proposal_id
 AND g.root_sha256=NEW.root_sha256 AND g.manifest_sha256=NEW.manifest_sha256 AND g.lease_created_at=NEW.lease_created_at
 AND NEW.version=0 AND NEW.event_sha256=g.event_sha256 AND NEW.checkpoint_sha256=g.checkpoint_sha256
 AND NEW.model_at=g.lease_created_at AND NEW.recorded_at=g.recorded_at AND NEW.wire_bytes=0 AND NEW.paused=0 AND NEW.stopped=0);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_control_head_advance BEFORE UPDATE ON wallet_warmup_execution_control_heads BEGIN
 SELECT RAISE(ABORT,'Exact warmup control head advance refused') WHERE
 NEW.owner_id IS NOT OLD.owner_id OR NEW.proposal_id IS NOT OLD.proposal_id OR NEW.root_sha256 IS NOT OLD.root_sha256
 OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256 OR NEW.lease_created_at IS NOT OLD.lease_created_at
 OR NEW.version!=OLD.version+1
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_control_events e WHERE e.owner_id=OLD.owner_id AND e.proposal_id=OLD.proposal_id
 AND e.sequence=NEW.version AND e.root_sha256=OLD.root_sha256 AND e.manifest_sha256=OLD.manifest_sha256
 AND e.previous_event_sha256=OLD.event_sha256 AND e.previous_checkpoint_sha256=OLD.checkpoint_sha256
 AND e.event_sha256=NEW.event_sha256 AND e.checkpoint_sha256=NEW.checkpoint_sha256
 AND e.model_at=NEW.model_at AND e.recorded_at=NEW.recorded_at AND NEW.model_at>=OLD.model_at AND NEW.recorded_at>=OLD.recorded_at
 AND NEW.wire_bytes=OLD.wire_bytes+length(CAST(e.wire AS BLOB))
 AND NEW.paused= CASE e.operation WHEN 'pause' THEN 1 WHEN 'resume' THEN 0 ELSE OLD.paused END
 AND NEW.stopped= CASE e.operation WHEN 'stop' THEN 1 ELSE OLD.stopped END);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_control_head_no_delete BEFORE DELETE ON wallet_warmup_execution_control_heads BEGIN SELECT RAISE(ABORT,'Warmup control head cannot be deleted'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_control_intent_insert BEFORE INSERT ON wallet_warmup_execution_control_intents BEGIN
 SELECT RAISE(ABORT,'Exact warmup control intent refused') WHERE
 EXISTS(SELECT 1 FROM wallet_warmup_execution_control_intents i WHERE i.owner_id=NEW.owner_id AND i.id=NEW.id)
 OR NEW.model_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_control_heads h JOIN wallet_warmup_execution_geneses g ON g.owner_id=h.owner_id AND g.proposal_id=h.proposal_id
 JOIN wallet_warmup_execution_roots r ON r.owner_id=g.owner_id AND r.proposal_id=g.proposal_id
 JOIN wallet_warmup_execution_approvals a ON a.owner_id=r.owner_id AND a.proposal_id=r.proposal_id
 WHERE h.owner_id=NEW.owner_id AND h.proposal_id=NEW.proposal_id AND h.root_sha256=NEW.root_sha256 AND h.manifest_sha256=NEW.manifest_sha256
 AND h.version=NEW.expected_version AND h.event_sha256=NEW.expected_event_sha256 AND h.checkpoint_sha256=NEW.expected_checkpoint_sha256
 AND NEW.model_at>=h.model_at AND NEW.model_at>=h.recorded_at AND h.version<76100 AND ((NEW.operation='pause' AND h.paused=0) OR (NEW.operation='resume' AND h.paused=1) OR NEW.operation='stop') AND h.stopped=0 AND (NEW.operation='stop' OR (h.version<76096 AND strftime('%Y-%m-%dT%H:%M:%fZ','now')<a.session_expires_at)));
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_control_intent_capacity BEFORE INSERT ON wallet_warmup_execution_control_intents BEGIN
 SELECT RAISE(ABORT,'Warmup control intent capacity exhausted') WHERE
 (SELECT count(*) FROM wallet_warmup_execution_control_intents i WHERE i.owner_id=NEW.owner_id AND i.proposal_id=NEW.proposal_id)>=152204
 OR (NEW.operation!='stop' AND (SELECT count(*) FROM wallet_warmup_execution_control_intents i WHERE i.owner_id=NEW.owner_id AND i.proposal_id=NEW.proposal_id)>=152200);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_control_intent_no_update BEFORE UPDATE ON wallet_warmup_execution_control_intents BEGIN SELECT RAISE(ABORT,'Warmup control intents are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_control_intent_no_delete BEFORE DELETE ON wallet_warmup_execution_control_intents BEGIN SELECT RAISE(ABORT,'Warmup control intents are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_control_event_insert BEFORE INSERT ON wallet_warmup_execution_control_events BEGIN
 SELECT RAISE(ABORT,'Exact warmup control event refused') WHERE
 EXISTS(SELECT 1 FROM wallet_warmup_execution_control_events e WHERE e.owner_id=NEW.owner_id AND (e.id=NEW.id OR (e.proposal_id=NEW.proposal_id AND e.sequence=NEW.sequence)))
 OR NEW.recorded_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ','now') OR NEW.recorded_at<NEW.model_at
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_execution_control_heads h JOIN wallet_warmup_execution_geneses g ON g.owner_id=h.owner_id AND g.proposal_id=h.proposal_id
 JOIN wallet_warmup_execution_roots r ON r.owner_id=g.owner_id AND r.proposal_id=g.proposal_id
 JOIN wallet_warmup_execution_approvals a ON a.owner_id=r.owner_id AND a.proposal_id=r.proposal_id
 JOIN wallet_warmup_execution_control_intents i ON i.owner_id=h.owner_id AND i.proposal_id=h.proposal_id
 WHERE h.owner_id=NEW.owner_id AND h.proposal_id=NEW.proposal_id AND i.id=NEW.id
 AND h.root_sha256=NEW.root_sha256 AND h.manifest_sha256=NEW.manifest_sha256
 AND i.root_sha256=h.root_sha256 AND i.manifest_sha256=h.manifest_sha256
 AND i.expected_version=h.version AND i.expected_event_sha256=h.event_sha256 AND i.expected_checkpoint_sha256=h.checkpoint_sha256
 AND NEW.sequence=h.version+1 AND NEW.previous_event_sha256=h.event_sha256 AND NEW.previous_checkpoint_sha256=h.checkpoint_sha256
 AND i.operation=NEW.operation AND i.model_at=NEW.model_at AND NEW.model_at>=h.model_at AND NEW.model_at>=h.recorded_at
 AND NEW.recorded_at>=h.recorded_at AND h.wire_bytes+length(CAST(NEW.wire AS BLOB))<=134217728
 AND h.version<76100 AND ((NEW.operation='pause' AND h.paused=0) OR (NEW.operation='resume' AND h.paused=1) OR NEW.operation='stop') AND h.stopped=0 AND (NEW.operation='stop' OR (h.version<76096 AND strftime('%Y-%m-%dT%H:%M:%fZ','now')<a.session_expires_at)));
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_control_event_wire BEFORE INSERT ON wallet_warmup_execution_control_events BEGIN
 SELECT RAISE(ABORT,'Exact warmup control event wire refused') WHERE NEW.wire IS NOT
 json_object('event',json_object('expectedRootSha256',NEW.manifest_sha256,'expectedVersion',NEW.sequence-1,'now',(CAST(strftime('%s',NEW.model_at) AS INTEGER)*1000+CAST(substr(NEW.model_at,21,3) AS INTEGER)),'operation',NEW.operation),
 'format','wallet-warmup-execution-event-v1','manifestSha256',NEW.manifest_sha256,'previousSha256',NEW.previous_event_sha256,
 'rootId',NEW.proposal_id,'rootSha256',NEW.root_sha256,'sequence',NEW.sequence,'sha256',NEW.event_sha256);
END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_control_event_no_update BEFORE UPDATE ON wallet_warmup_execution_control_events BEGIN SELECT RAISE(ABORT,'Warmup control events are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_control_event_no_delete BEFORE DELETE ON wallet_warmup_execution_control_events BEGIN SELECT RAISE(ABORT,'Warmup control events are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_execution_control_event_advance AFTER INSERT ON wallet_warmup_execution_control_events BEGIN
 UPDATE wallet_warmup_execution_control_heads SET version=NEW.sequence,event_sha256=NEW.event_sha256,checkpoint_sha256=NEW.checkpoint_sha256,
 model_at=NEW.model_at,recorded_at=NEW.recorded_at,wire_bytes=wire_bytes+length(CAST(NEW.wire AS BLOB)),
 paused= CASE NEW.operation WHEN 'pause' THEN 1 WHEN 'resume' THEN 0 ELSE paused END,
 stopped= CASE NEW.operation WHEN 'stop' THEN 1 ELSE stopped END
 WHERE owner_id=NEW.owner_id AND proposal_id=NEW.proposal_id AND root_sha256=NEW.root_sha256 AND manifest_sha256=NEW.manifest_sha256
 AND version=NEW.sequence-1 AND event_sha256=NEW.previous_event_sha256 AND checkpoint_sha256=NEW.previous_checkpoint_sha256;
 SELECT RAISE(ABORT,'Warmup control head changed') WHERE changes()!=1;
END;
