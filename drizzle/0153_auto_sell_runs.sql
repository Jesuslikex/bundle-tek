CREATE TABLE auto_sell_runs (
 owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 128),
 id TEXT NOT NULL,project_id TEXT NOT NULL,project_revision INTEGER NOT NULL CHECK(project_revision BETWEEN 1 AND 1000000000),
 profile_save_id TEXT NOT NULL,profile_sha256 TEXT NOT NULL CHECK(length(profile_sha256)=64 AND profile_sha256 NOT GLOB '*[^a-f0-9]*'),
 document TEXT NOT NULL CHECK(json_valid(document) AND length(CAST(document AS BLOB))<=393216),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
 source_document TEXT NOT NULL,own_wallets_json TEXT NOT NULL CHECK(json_valid(own_wallets_json)),
 created_at TEXT NOT NULL,active_at TEXT NOT NULL,ends_at TEXT,
 PRIMARY KEY(owner_id,id)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX auto_sell_runs_owner_project ON auto_sell_runs(owner_id,project_id,created_at DESC,id DESC);
--> statement-breakpoint
CREATE TABLE auto_sell_run_heads (
 owner_id TEXT NOT NULL,run_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence BETWEEN 0 AND 1000),
 head_sha256 TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('open','stopped')),
 accounted_high INTEGER NOT NULL CHECK(typeof(accounted_high)='integer' AND accounted_high BETWEEN 0 AND 999999999),
 accounted_middle INTEGER NOT NULL CHECK(typeof(accounted_middle)='integer' AND accounted_middle BETWEEN 0 AND 999999999),
 accounted_low INTEGER NOT NULL CHECK(typeof(accounted_low)='integer' AND accounted_low BETWEEN 0 AND 999999999),
 total_bytes INTEGER NOT NULL CHECK(typeof(total_bytes)='integer' AND total_bytes BETWEEN 1 AND 33554432),
 updated_at TEXT NOT NULL,PRIMARY KEY(owner_id,run_id),
 FOREIGN KEY(owner_id,run_id) REFERENCES auto_sell_runs(owner_id,id)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE auto_sell_run_strategy_heads (
 owner_id TEXT NOT NULL,run_id TEXT NOT NULL,strategy_id TEXT NOT NULL,last_attempt_id TEXT,
 accounted_high INTEGER NOT NULL CHECK(typeof(accounted_high)='integer' AND accounted_high BETWEEN 0 AND 999999999),
 accounted_middle INTEGER NOT NULL CHECK(typeof(accounted_middle)='integer' AND accounted_middle BETWEEN 0 AND 999999999),
 accounted_low INTEGER NOT NULL CHECK(typeof(accounted_low)='integer' AND accounted_low BETWEEN 0 AND 999999999),
 cap_high INTEGER,cap_middle INTEGER,cap_low INTEGER,
 next_dca_index INTEGER NOT NULL CHECK(next_dca_index BETWEEN 0 AND 1000),next_dca_at TEXT,
 PRIMARY KEY(owner_id,run_id,strategy_id),
 CHECK((cap_high IS NULL AND cap_middle IS NULL AND cap_low IS NULL) OR
  (typeof(cap_high)='integer' AND cap_high BETWEEN 0 AND 999999999 AND typeof(cap_middle)='integer' AND cap_middle BETWEEN 0 AND 999999999 AND typeof(cap_low)='integer' AND cap_low BETWEEN 0 AND 999999999)),
 FOREIGN KEY(owner_id,run_id) REFERENCES auto_sell_runs(owner_id,id)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE auto_sell_run_attempts (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,run_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 1000),
 previous_sha256 TEXT NOT NULL,sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
 strategy_id TEXT NOT NULL,wallet TEXT NOT NULL,wallet_revision INTEGER NOT NULL CHECK(wallet_revision BETWEEN 1 AND 1000000000),
 input_raw TEXT NOT NULL CHECK(length(input_raw) BETWEEN 1 AND 20 AND input_raw NOT GLOB '*[^0-9]*' AND input_raw<>'0' AND (length(input_raw)=1 OR substr(input_raw,1,1)<>'0') AND (length(input_raw)<20 OR input_raw<='18446744073709551615')),
 amount_high INTEGER NOT NULL CHECK(typeof(amount_high)='integer' AND amount_high BETWEEN 0 AND 999999999),
 amount_middle INTEGER NOT NULL CHECK(typeof(amount_middle)='integer' AND amount_middle BETWEEN 0 AND 999999999),
 amount_low INTEGER NOT NULL CHECK(typeof(amount_low)='integer' AND amount_low BETWEEN 0 AND 999999999),
 preparation_id TEXT NOT NULL UNIQUE,document TEXT NOT NULL CHECK(json_valid(document) AND length(CAST(document AS BLOB))<=32768),
 reserved_at TEXT NOT NULL,PRIMARY KEY(owner_id,id),UNIQUE(owner_id,run_id,sequence),
 FOREIGN KEY(owner_id,run_id) REFERENCES auto_sell_runs(owner_id,id),
 CHECK(input_raw IS (CASE WHEN amount_high>0 THEN CAST(amount_high AS TEXT)||printf('%09d%09d',amount_middle,amount_low) WHEN amount_middle>0 THEN CAST(amount_middle AS TEXT)||printf('%09d',amount_low) ELSE CAST(amount_low AS TEXT) END))
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX auto_sell_run_attempts_run ON auto_sell_run_attempts(owner_id,run_id,sequence);
--> statement-breakpoint
CREATE TABLE auto_sell_run_occurrences (
 owner_id TEXT NOT NULL,run_id TEXT NOT NULL,strategy_id TEXT NOT NULL,key TEXT NOT NULL,
 attempt_id TEXT NOT NULL,PRIMARY KEY(owner_id,run_id,strategy_id,key),
 FOREIGN KEY(owner_id,attempt_id) REFERENCES auto_sell_run_attempts(owner_id,id)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE auto_sell_run_preparation_starts (
 owner_id TEXT NOT NULL,run_id TEXT NOT NULL,attempt_id TEXT NOT NULL,preparation_id TEXT NOT NULL UNIQUE,
 head_sequence INTEGER NOT NULL,head_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,attempt_id),FOREIGN KEY(owner_id,attempt_id) REFERENCES auto_sell_run_attempts(owner_id,id)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE auto_sell_run_stops (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,run_id TEXT NOT NULL,run_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,run_id),
 FOREIGN KEY(owner_id,run_id) REFERENCES auto_sell_runs(owner_id,id)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE VIEW auto_sell_run_current_sources AS SELECT r.owner_id,r.id FROM auto_sell_runs r WHERE EXISTS(SELECT 1 FROM imported_token_projects p WHERE p.owner_id=r.owner_id AND p.id=r.project_id AND p.revision=r.project_revision AND p.archived=0 AND p.chain='Solana' AND p.document=r.source_document AND p.address=json_extract(r.document,'$.profile.terms.token.mint'))
 AND EXISTS(SELECT 1 FROM auto_sell_profiles f WHERE f.owner_id=r.owner_id AND f.id=r.profile_save_id AND f.project_id=r.project_id AND f.sha256=r.profile_sha256 AND f.document=json_extract(r.document,'$.profile'))
 AND json_type(r.own_wallets_json)='array' AND json_array_length(r.own_wallets_json) BETWEEN 1 AND 1000
 AND (SELECT count(*) FROM workspace_wallets w WHERE w.owner_id=r.owner_id AND w.chain='Solana')=json_array_length(r.own_wallets_json)
 AND NOT EXISTS(SELECT 1 FROM json_each(r.own_wallets_json) j WHERE NOT EXISTS(SELECT 1 FROM workspace_wallets w WHERE w.owner_id=r.owner_id AND w.chain='Solana' AND w.address=json_extract(j.value,'$.address') AND w.revision=json_extract(j.value,'$.revision') AND w.archived=json_extract(j.value,'$.archived')));
--> statement-breakpoint
CREATE TRIGGER auto_sell_runs_insert BEFORE INSERT ON auto_sell_runs BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM auto_sell_runs WHERE owner_id=NEW.owner_id AND id=NEW.id)
 THEN RAISE(ABORT,'Auto Sell run ID already used') END;
 SELECT CASE WHEN (SELECT count(*) FROM auto_sell_runs WHERE owner_id=NEW.owner_id AND project_id=NEW.project_id)>=100
 THEN RAISE(ABORT,'Auto Sell run history full') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM auto_sell_runs r JOIN auto_sell_run_attempts a ON a.owner_id=r.owner_id AND a.run_id=r.id
 WHERE r.owner_id=NEW.owner_id AND json_extract(r.document,'$.profile.terms.token.mint')=json_extract(NEW.document,'$.profile.terms.token.mint')
 AND EXISTS(SELECT 1 FROM json_each(NEW.document,'$.profile.terms.wallets') w WHERE json_extract(w.value,'$.address')=a.wallet))
 THEN RAISE(ABORT,'Auto Sell earlier same-token allowance remains held') END;
 SELECT CASE WHEN NOT (
 json_type(NEW.document,'$.limits.sessionRaw') IS 'null' OR
 (json_type(NEW.document,'$.limits.sessionRaw') IS 'text'
 AND length(json_extract(NEW.document,'$.limits.sessionRaw')) BETWEEN 1 AND 20
 AND json_extract(NEW.document,'$.limits.sessionRaw') NOT GLOB '*[^0-9]*'
 AND (length(json_extract(NEW.document,'$.limits.sessionRaw'))=1 OR substr(json_extract(NEW.document,'$.limits.sessionRaw'),1,1)<>'0')
 AND (length(json_extract(NEW.document,'$.limits.sessionRaw'))<20 OR json_extract(NEW.document,'$.limits.sessionRaw')<='18446744073709551615'))
 ) THEN RAISE(ABORT,'Auto Sell run cap invalid') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.document,'$.limits.strategies') l WHERE NOT (
 json_type(l.value,'$.capRaw') IS 'null' OR (json_type(l.value,'$.capRaw') IS 'text'
 AND length(json_extract(l.value,'$.capRaw')) BETWEEN 1 AND 20 AND json_extract(l.value,'$.capRaw') NOT GLOB '*[^0-9]*'
 AND (length(json_extract(l.value,'$.capRaw'))=1 OR substr(json_extract(l.value,'$.capRaw'),1,1)<>'0')
 AND (length(json_extract(l.value,'$.capRaw'))<20 OR json_extract(l.value,'$.capRaw')<='18446744073709551615'))
 )) THEN RAISE(ABORT,'Auto Sell strategy cap invalid') END;
 SELECT CASE WHEN json_type(NEW.document,'$.profile.terms.configuration.session.startDelaySeconds') IS NOT 'integer'
 OR json_extract(NEW.document,'$.profile.terms.configuration.session.startDelaySeconds') NOT BETWEEN 0 AND 86400
 OR json_type(NEW.document,'$.profile.terms.configuration.session.endDurationSeconds') IS NOT 'integer'
 OR json_extract(NEW.document,'$.profile.terms.configuration.session.endDurationSeconds') NOT BETWEEN 0 AND 86400
 OR (json_type(NEW.document,'$.endsAt') IS NOT 'null' AND json_type(NEW.document,'$.endsAt') IS NOT 'text')
 OR NEW.active_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at,'+'||json_extract(NEW.document,'$.profile.terms.configuration.session.startDelaySeconds')||' seconds')
 OR NEW.ends_at IS NOT CASE WHEN json_extract(NEW.document,'$.profile.terms.configuration.session.endDurationSeconds')=0 THEN NULL
 ELSE strftime('%Y-%m-%dT%H:%M:%fZ',NEW.active_at,'+'||json_extract(NEW.document,'$.profile.terms.configuration.session.endDurationSeconds')||' seconds') END
 THEN RAISE(ABORT,'Auto Sell run lifetime invalid') END;
 SELECT CASE WHEN json_type(NEW.document,'$.limits.strategies') IS NOT 'array'
 OR json_array_length(NEW.document,'$.limits.strategies') IS NOT json_array_length(NEW.document,'$.profile.terms.configuration.strategies')
 OR (SELECT count(DISTINCT json_extract(l.value,'$.id')) FROM json_each(NEW.document,'$.limits.strategies') l)<>json_array_length(NEW.document,'$.limits.strategies')
 OR EXISTS(SELECT 1 FROM json_each(NEW.document,'$.limits.strategies') l WHERE
  json_type(l.value,'$.id') IS NOT 'text' OR (json_type(l.value,'$.endsAt') IS NOT 'null' AND json_type(l.value,'$.endsAt') IS NOT 'text')
  OR NOT EXISTS(SELECT 1 FROM json_each(NEW.document,'$.profile.terms.configuration.strategies') s WHERE
   json_extract(s.value,'$.id')=json_extract(l.value,'$.id') AND json_type(s.value,'$.endDurationSeconds') IS 'integer'
   AND json_extract(s.value,'$.endDurationSeconds') BETWEEN 0 AND 2592000
   AND json_extract(l.value,'$.endsAt') IS CASE WHEN json_extract(s.value,'$.endDurationSeconds')=0 THEN NULL
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ',NEW.active_at,'+'||json_extract(s.value,'$.endDurationSeconds')||' seconds') END))
 THEN RAISE(ABORT,'Auto Sell strategy limits invalid') END;
 SELECT CASE WHEN json_extract(NEW.document,'$.format') IS NOT 'auto-sell-run-v1'
 OR json_type(NEW.document,'$.signingAllowed') IS NOT 'false' OR json_type(NEW.document,'$.executionAllowed') IS NOT 'false' OR json_type(NEW.document,'$.automaticResumeAllowed') IS NOT 'false'
 OR json_extract(NEW.document,'$.id') IS NOT NEW.id OR json_extract(NEW.document,'$.sha256') IS NOT NEW.sha256
 OR json_extract(NEW.document,'$.createdAt') IS NOT NEW.created_at OR json_extract(NEW.document,'$.activeAt') IS NOT NEW.active_at OR json_extract(NEW.document,'$.endsAt') IS NOT NEW.ends_at
 OR json_extract(NEW.document,'$.profile.id') IS NOT NEW.profile_save_id OR json_extract(NEW.document,'$.profile.sha256') IS NOT NEW.profile_sha256
 OR json_extract(NEW.document,'$.profile.terms.projectId') IS NOT NEW.project_id OR json_extract(NEW.document,'$.profile.terms.projectRevision') IS NOT NEW.project_revision
 OR json_extract(NEW.document,'$.ownWallets') IS NOT NEW.own_wallets_json
 OR length(NEW.created_at)!=24 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) IS NOT NEW.created_at
 OR NEW.created_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 seconds') OR NEW.created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 seconds')
 OR NOT (EXISTS(SELECT 1 FROM imported_token_projects p WHERE p.owner_id=NEW.owner_id AND p.id=NEW.project_id AND p.revision=NEW.project_revision AND p.archived=0 AND p.chain='Solana' AND p.document=NEW.source_document AND p.address=json_extract(NEW.document,'$.profile.terms.token.mint'))
 AND EXISTS(SELECT 1 FROM auto_sell_profiles f WHERE f.owner_id=NEW.owner_id AND f.id=NEW.profile_save_id AND f.project_id=NEW.project_id AND f.sha256=NEW.profile_sha256 AND f.document=json_extract(NEW.document,'$.profile'))
 AND json_type(NEW.own_wallets_json)='array' AND json_array_length(NEW.own_wallets_json) BETWEEN 1 AND 1000
 AND (SELECT count(*) FROM workspace_wallets w WHERE w.owner_id=NEW.owner_id AND w.chain='Solana')=json_array_length(NEW.own_wallets_json)
 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.own_wallets_json) j WHERE NOT EXISTS(SELECT 1 FROM workspace_wallets w WHERE w.owner_id=NEW.owner_id AND w.chain='Solana' AND w.address=json_extract(j.value,'$.address') AND w.revision=json_extract(j.value,'$.revision') AND w.archived=json_extract(j.value,'$.archived')))) THEN RAISE(ABORT,'Auto Sell run source changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_runs_initialize AFTER INSERT ON auto_sell_runs BEGIN
 INSERT INTO auto_sell_run_heads VALUES(NEW.owner_id,NEW.id,0,NEW.sha256,'open',0,0,0,length(CAST(NEW.document AS BLOB)),NEW.created_at);
 INSERT INTO auto_sell_run_strategy_heads
 SELECT NEW.owner_id,NEW.id,json_extract(j.value,'$.id'),NULL,0,0,0,
 CASE WHEN json_extract(j.value,'$.capRaw') IS NULL THEN NULL ELSE CAST(substr(substr('000000000000000000000000000'||json_extract(j.value,'$.capRaw'),-27),1,9) AS INTEGER) END,CASE WHEN json_extract(j.value,'$.capRaw') IS NULL THEN NULL ELSE CAST(substr(substr('000000000000000000000000000'||json_extract(j.value,'$.capRaw'),-27),10,9) AS INTEGER) END,CASE WHEN json_extract(j.value,'$.capRaw') IS NULL THEN NULL ELSE CAST(substr(substr('000000000000000000000000000'||json_extract(j.value,'$.capRaw'),-27),19,9) AS INTEGER) END,0,
 CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.document,'$.profile.terms.configuration.strategies') s WHERE json_extract(s.value,'$.id')=json_extract(j.value,'$.id') AND json_extract(s.value,'$.mode')='dca') THEN NEW.active_at ELSE NULL END
 FROM json_each(NEW.document,'$.limits.strategies') j;
END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_attempts_insert BEFORE INSERT ON auto_sell_run_attempts BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM auto_sell_run_attempts WHERE (owner_id=NEW.owner_id AND id=NEW.id) OR preparation_id=NEW.preparation_id)
 THEN RAISE(ABORT,'Auto Sell attempt identity already used') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM imported_swap_preparations WHERE id=NEW.preparation_id)
 OR EXISTS(SELECT 1 FROM imported_swap_signing_intents WHERE preparation_id=NEW.preparation_id)
 THEN RAISE(ABORT,'Auto Sell preparation identity already used') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM auto_sell_run_attempts a JOIN auto_sell_runs old_run ON old_run.owner_id=a.owner_id AND old_run.id=a.run_id
 JOIN auto_sell_runs new_run ON new_run.owner_id=NEW.owner_id AND new_run.id=NEW.run_id
 WHERE a.owner_id=NEW.owner_id AND a.run_id<>NEW.run_id AND a.wallet=NEW.wallet
 AND json_extract(old_run.document,'$.profile.terms.token.mint')=json_extract(new_run.document,'$.profile.terms.token.mint'))
 THEN RAISE(ABORT,'Auto Sell earlier same-token allowance remains held') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM auto_sell_run_preparation_starts s WHERE s.owner_id=NEW.owner_id AND s.run_id=NEW.run_id
 AND NOT EXISTS(SELECT 1 FROM imported_swap_preparations p WHERE p.owner_id=s.owner_id AND p.id=s.preparation_id))
 THEN RAISE(ABORT,'Auto Sell run preparation remains held') END;
 SELECT CASE WHEN NOT (
 json_extract(NEW.document,'$.format') IS 'auto-sell-run-attempt-v1'
 AND json_type(NEW.document,'$.signingAllowed') IS 'false' AND json_type(NEW.document,'$.executionAllowed') IS 'false' AND json_type(NEW.document,'$.automaticResumeAllowed') IS 'false'
 AND json_extract(NEW.document,'$.id') IS NEW.id AND json_extract(NEW.document,'$.runId') IS NEW.run_id
 AND json_extract(NEW.document,'$.sequence') IS NEW.sequence AND json_extract(NEW.document,'$.previousSha256') IS NEW.previous_sha256 AND json_extract(NEW.document,'$.sha256') IS NEW.sha256
 AND json_extract(NEW.document,'$.strategyId') IS NEW.strategy_id AND json_extract(NEW.document,'$.wallet') IS NEW.wallet AND json_extract(NEW.document,'$.walletRevision') IS NEW.wallet_revision
 AND json_extract(NEW.document,'$.inputRaw') IS NEW.input_raw AND json_extract(NEW.document,'$.preparationId') IS NEW.preparation_id AND json_extract(NEW.document,'$.reservedAt') IS NEW.reserved_at
 ) THEN RAISE(ABORT,'Auto Sell attempt document invalid') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM auto_sell_run_current_sources c WHERE c.owner_id=NEW.owner_id AND c.id=NEW.run_id)
 THEN RAISE(ABORT,'Auto Sell attempt source changed') END;
 SELECT CASE WHEN json_extract(NEW.document,'$.occurrence.kind')='counter' AND NOT (
 json_type(NEW.document,'$.occurrence.sourceIds') IS 'array' AND json_array_length(NEW.document,'$.occurrence.sourceIds') BETWEEN 1 AND 128
 AND (SELECT count(DISTINCT value) FROM json_each(NEW.document,'$.occurrence.sourceIds'))=json_array_length(NEW.document,'$.occurrence.sourceIds')
 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.document,'$.occurrence.sourceIds') j WHERE j.type<>'text' OR length(j.value) NOT BETWEEN 1 AND 128 OR length(CAST(j.value AS BLOB))>512)
 ) THEN RAISE(ABORT,'Auto Sell counter occurrence invalid') END;
 SELECT CASE WHEN json_extract(NEW.document,'$.occurrence.kind')='limit' AND NOT (
 json_type(NEW.document,'$.occurrence.ids') IS 'array' AND json_array_length(NEW.document,'$.occurrence.ids') BETWEEN 1 AND 128
 AND (SELECT count(DISTINCT value) FROM json_each(NEW.document,'$.occurrence.ids'))=json_array_length(NEW.document,'$.occurrence.ids')
 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.document,'$.occurrence.ids') j WHERE j.type<>'text' OR length(j.value) NOT BETWEEN 1 AND 128 OR length(CAST(j.value AS BLOB))>512
 OR NOT EXISTS(SELECT 1 FROM auto_sell_runs r,json_each(r.document,'$.profile.terms.configuration.strategies') s,json_each(s.value,'$.limitOrders') l
 WHERE r.owner_id=NEW.owner_id AND r.id=NEW.run_id AND json_extract(s.value,'$.id')=NEW.strategy_id AND json_extract(l.value,'$.id')=j.value))
 ) THEN RAISE(ABORT,'Auto Sell limit occurrence invalid') END;
 SELECT CASE WHEN NOT EXISTS(
 SELECT 1 FROM auto_sell_runs r JOIN auto_sell_run_heads h ON h.owner_id=r.owner_id AND h.run_id=r.id
 JOIN auto_sell_run_strategy_heads t ON t.owner_id=r.owner_id AND t.run_id=r.id AND t.strategy_id=NEW.strategy_id
 WHERE r.owner_id=NEW.owner_id AND r.id=NEW.run_id AND h.state='open' AND h.sequence+1=NEW.sequence AND h.head_sha256=NEW.previous_sha256
 AND NOT EXISTS(SELECT 1 FROM auto_sell_run_stops z WHERE z.owner_id=r.owner_id AND z.run_id=r.id)
 AND NEW.reserved_at>=r.active_at AND (r.ends_at IS NULL OR NEW.reserved_at<r.ends_at)
 AND (r.ends_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ','now')<r.ends_at)
 AND NEW.reserved_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 seconds') AND NEW.reserved_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 seconds')
 AND h.total_bytes+length(CAST(NEW.document AS BLOB))<=33554432
 AND EXISTS(SELECT 1 FROM json_each(r.document,'$.profile.terms.wallets') w WHERE json_extract(w.value,'$.address')=NEW.wallet AND json_extract(w.value,'$.revision')=NEW.wallet_revision)
 AND json_extract(NEW.document,'$.runSha256')=r.sha256
 AND EXISTS(SELECT 1 FROM json_each(r.document,'$.limits.strategies') l WHERE json_extract(l.value,'$.id')=NEW.strategy_id
  AND (json_extract(l.value,'$.endsAt') IS NULL OR (NEW.reserved_at<json_extract(l.value,'$.endsAt') AND strftime('%Y-%m-%dT%H:%M:%fZ','now')<json_extract(l.value,'$.endsAt'))))
 AND EXISTS(SELECT 1 FROM json_each(r.document,'$.profile.terms.configuration.strategies') s WHERE json_extract(s.value,'$.id')=NEW.strategy_id AND json_extract(s.value,'$.mode')=json_extract(NEW.document,'$.occurrence.kind'))
 ) THEN RAISE(ABORT,'Auto Sell attempt source or sequence changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_attempts_append AFTER INSERT ON auto_sell_run_attempts BEGIN
 UPDATE auto_sell_run_heads SET sequence=NEW.sequence,head_sha256=NEW.sha256,
 accounted_high=accounted_high+NEW.amount_high+(accounted_middle+NEW.amount_middle+(accounted_low+NEW.amount_low)/1000000000)/1000000000,accounted_middle=(accounted_middle+NEW.amount_middle+(accounted_low+NEW.amount_low)/1000000000)%1000000000,accounted_low=(accounted_low+NEW.amount_low)%1000000000,
 total_bytes=total_bytes+length(CAST(NEW.document AS BLOB)),updated_at=NEW.reserved_at
 WHERE owner_id=NEW.owner_id AND run_id=NEW.run_id;
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'Auto Sell run head unavailable') END;
 UPDATE auto_sell_run_strategy_heads SET last_attempt_id=NEW.id,
 accounted_high=accounted_high+NEW.amount_high+(accounted_middle+NEW.amount_middle+(accounted_low+NEW.amount_low)/1000000000)/1000000000,accounted_middle=(accounted_middle+NEW.amount_middle+(accounted_low+NEW.amount_low)/1000000000)%1000000000,accounted_low=(accounted_low+NEW.amount_low)%1000000000,
 next_dca_index= CASE WHEN json_extract(NEW.document,'$.occurrence.kind')='dca' THEN json_extract(NEW.document,'$.occurrence.index')+1 ELSE next_dca_index END,
 next_dca_at=CASE WHEN json_extract(NEW.document,'$.occurrence.kind')='dca' THEN
 (SELECT strftime('%Y-%m-%dT%H:%M:%fZ',NEW.reserved_at,'+'||json_extract(s.value,'$.dcaIntervalSeconds')||' seconds')
 FROM auto_sell_runs r,json_each(r.document,'$.profile.terms.configuration.strategies') s WHERE r.owner_id=NEW.owner_id AND r.id=NEW.run_id AND json_extract(s.value,'$.id')=NEW.strategy_id)
 ELSE next_dca_at END
 WHERE owner_id=NEW.owner_id AND run_id=NEW.run_id AND strategy_id=NEW.strategy_id;
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'Auto Sell strategy head unavailable') END;
 INSERT INTO auto_sell_run_occurrences
 SELECT NEW.owner_id,NEW.run_id,NEW.strategy_id,'dca:'||json_extract(NEW.document,'$.occurrence.index'),NEW.id WHERE json_extract(NEW.document,'$.occurrence.kind')='dca'
 UNION ALL SELECT NEW.owner_id,NEW.run_id,NEW.strategy_id,'limit:'||j.value,NEW.id FROM json_each(NEW.document,'$.occurrence.ids') j WHERE json_extract(NEW.document,'$.occurrence.kind')='limit'
 UNION ALL SELECT NEW.owner_id,NEW.run_id,NEW.strategy_id,'counter:'||j.value,NEW.id FROM json_each(NEW.document,'$.occurrence.sourceIds') j WHERE json_extract(NEW.document,'$.occurrence.kind')='counter';
END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_heads_insert BEFORE INSERT ON auto_sell_run_heads BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM auto_sell_run_heads WHERE owner_id=NEW.owner_id AND run_id=NEW.run_id)
 OR NOT EXISTS(SELECT 1 FROM auto_sell_runs r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.run_id AND NEW.sequence=0 AND NEW.head_sha256=r.sha256 AND NEW.state='open' AND NEW.accounted_high=0 AND NEW.accounted_middle=0 AND NEW.accounted_low=0 AND NEW.total_bytes=length(CAST(r.document AS BLOB)) AND NEW.updated_at=r.created_at)
 THEN RAISE(ABORT,'Auto Sell initial head invalid') END;
END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_heads_update BEFORE UPDATE ON auto_sell_run_heads BEGIN
 SELECT CASE WHEN NEW.owner_id IS NOT OLD.owner_id OR NEW.run_id IS NOT OLD.run_id OR NOT (
 (OLD.state='open' AND NEW.state='open' AND NEW.sequence=OLD.sequence+1 AND EXISTS(
 SELECT 1 FROM auto_sell_run_attempts a JOIN auto_sell_runs r ON r.owner_id=a.owner_id AND r.id=a.run_id
 WHERE a.owner_id=OLD.owner_id AND a.run_id=OLD.run_id AND a.sequence=NEW.sequence AND a.previous_sha256=OLD.head_sha256 AND a.sha256=NEW.head_sha256
 AND NEW.accounted_high=OLD.accounted_high+a.amount_high+(OLD.accounted_middle+a.amount_middle+(OLD.accounted_low+a.amount_low)/1000000000)/1000000000 AND NEW.accounted_middle=(OLD.accounted_middle+a.amount_middle+(OLD.accounted_low+a.amount_low)/1000000000)%1000000000 AND NEW.accounted_low=(OLD.accounted_low+a.amount_low)%1000000000
 AND NEW.total_bytes=OLD.total_bytes+length(CAST(a.document AS BLOB)) AND NEW.updated_at=a.reserved_at
 AND (json_extract(r.document,'$.limits.sessionRaw') IS NULL OR
 (length(CASE WHEN NEW.accounted_high>0 THEN CAST(NEW.accounted_high AS TEXT)||printf('%09d%09d',NEW.accounted_middle,NEW.accounted_low) WHEN NEW.accounted_middle>0 THEN CAST(NEW.accounted_middle AS TEXT)||printf('%09d',NEW.accounted_low) ELSE CAST(NEW.accounted_low AS TEXT) END)<length(json_extract(r.document,'$.limits.sessionRaw')) OR
 (length(CASE WHEN NEW.accounted_high>0 THEN CAST(NEW.accounted_high AS TEXT)||printf('%09d%09d',NEW.accounted_middle,NEW.accounted_low) WHEN NEW.accounted_middle>0 THEN CAST(NEW.accounted_middle AS TEXT)||printf('%09d',NEW.accounted_low) ELSE CAST(NEW.accounted_low AS TEXT) END)=length(json_extract(r.document,'$.limits.sessionRaw')) AND CASE WHEN NEW.accounted_high>0 THEN CAST(NEW.accounted_high AS TEXT)||printf('%09d%09d',NEW.accounted_middle,NEW.accounted_low) WHEN NEW.accounted_middle>0 THEN CAST(NEW.accounted_middle AS TEXT)||printf('%09d',NEW.accounted_low) ELSE CAST(NEW.accounted_low AS TEXT) END<=json_extract(r.document,'$.limits.sessionRaw'))))
 ))
 OR (OLD.state='open' AND NEW.state='stopped' AND NEW.sequence=OLD.sequence AND NEW.head_sha256=OLD.head_sha256
 AND NEW.accounted_high=OLD.accounted_high AND NEW.accounted_middle=OLD.accounted_middle AND NEW.accounted_low=OLD.accounted_low AND NEW.total_bytes=OLD.total_bytes
 AND EXISTS(SELECT 1 FROM auto_sell_run_stops s WHERE s.owner_id=OLD.owner_id AND s.run_id=OLD.run_id AND s.created_at=NEW.updated_at))
 ) THEN RAISE(ABORT,'Auto Sell head requires exact append') END;
END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_strategy_heads_insert BEFORE INSERT ON auto_sell_run_strategy_heads BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM auto_sell_run_strategy_heads WHERE owner_id=NEW.owner_id AND run_id=NEW.run_id AND strategy_id=NEW.strategy_id)
 OR NOT EXISTS(SELECT 1 FROM auto_sell_runs r,json_each(r.document,'$.limits.strategies') s
 WHERE r.owner_id=NEW.owner_id AND r.id=NEW.run_id AND json_extract(s.value,'$.id')=NEW.strategy_id
 AND NEW.last_attempt_id IS NULL AND NEW.accounted_high=0 AND NEW.accounted_middle=0 AND NEW.accounted_low=0 AND NEW.next_dca_index=0
 AND NEW.cap_high IS CASE WHEN json_extract(s.value,'$.capRaw') IS NULL THEN NULL ELSE CAST(substr(substr('000000000000000000000000000'||json_extract(s.value,'$.capRaw'),-27),1,9) AS INTEGER) END AND NEW.cap_middle IS CASE WHEN json_extract(s.value,'$.capRaw') IS NULL THEN NULL ELSE CAST(substr(substr('000000000000000000000000000'||json_extract(s.value,'$.capRaw'),-27),10,9) AS INTEGER) END AND NEW.cap_low IS CASE WHEN json_extract(s.value,'$.capRaw') IS NULL THEN NULL ELSE CAST(substr(substr('000000000000000000000000000'||json_extract(s.value,'$.capRaw'),-27),19,9) AS INTEGER) END
 ) THEN RAISE(ABORT,'Auto Sell strategy initial head invalid') END;
END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_strategy_heads_update BEFORE UPDATE ON auto_sell_run_strategy_heads BEGIN
 SELECT CASE WHEN NEW.owner_id IS NOT OLD.owner_id OR NEW.run_id IS NOT OLD.run_id OR NEW.strategy_id IS NOT OLD.strategy_id
 OR NEW.cap_high IS NOT OLD.cap_high OR NEW.cap_middle IS NOT OLD.cap_middle OR NEW.cap_low IS NOT OLD.cap_low
 OR NOT EXISTS(SELECT 1 FROM auto_sell_run_attempts a JOIN auto_sell_run_heads h ON h.owner_id=a.owner_id AND h.run_id=a.run_id JOIN auto_sell_runs r ON r.owner_id=a.owner_id AND r.id=a.run_id
 WHERE a.owner_id=OLD.owner_id AND a.run_id=OLD.run_id AND a.strategy_id=OLD.strategy_id AND a.id=NEW.last_attempt_id AND a.id IS NOT OLD.last_attempt_id
 AND a.sequence=h.sequence AND a.sha256=h.head_sha256 AND h.state='open'
 AND NEW.accounted_high=OLD.accounted_high+a.amount_high+(OLD.accounted_middle+a.amount_middle+(OLD.accounted_low+a.amount_low)/1000000000)/1000000000 AND NEW.accounted_middle=(OLD.accounted_middle+a.amount_middle+(OLD.accounted_low+a.amount_low)/1000000000)%1000000000 AND NEW.accounted_low=(OLD.accounted_low+a.amount_low)%1000000000
 AND (OLD.cap_high IS NULL OR NEW.accounted_high<OLD.cap_high OR
 (NEW.accounted_high=OLD.cap_high AND NEW.accounted_middle<OLD.cap_middle) OR
 (NEW.accounted_high=OLD.cap_high AND NEW.accounted_middle=OLD.cap_middle AND NEW.accounted_low<=OLD.cap_low))
 AND ((json_extract(a.document,'$.occurrence.kind')='dca' AND json_extract(a.document,'$.occurrence.index')=OLD.next_dca_index AND a.reserved_at>=OLD.next_dca_at
 AND NEW.next_dca_index=OLD.next_dca_index+1 AND NEW.next_dca_at=(SELECT strftime('%Y-%m-%dT%H:%M:%fZ',a.reserved_at,'+'||json_extract(s.value,'$.dcaIntervalSeconds')||' seconds') FROM json_each(r.document,'$.profile.terms.configuration.strategies') s WHERE json_extract(s.value,'$.id')=OLD.strategy_id))
 OR (json_extract(a.document,'$.occurrence.kind') IN ('counter','limit') AND NEW.next_dca_index=OLD.next_dca_index AND NEW.next_dca_at IS OLD.next_dca_at))
 ) THEN RAISE(ABORT,'Auto Sell strategy head requires exact append') END;
END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_occurrences_insert BEFORE INSERT ON auto_sell_run_occurrences BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM auto_sell_run_occurrences WHERE owner_id=NEW.owner_id AND run_id=NEW.run_id AND strategy_id=NEW.strategy_id AND key=NEW.key)
 OR NOT EXISTS(SELECT 1 FROM auto_sell_run_attempts a WHERE a.owner_id=NEW.owner_id AND a.id=NEW.attempt_id AND a.run_id=NEW.run_id AND a.strategy_id=NEW.strategy_id
 AND ((json_extract(a.document,'$.occurrence.kind')='dca' AND NEW.key='dca:'||json_extract(a.document,'$.occurrence.index'))
 OR (json_extract(a.document,'$.occurrence.kind')='limit' AND EXISTS(SELECT 1 FROM json_each(a.document,'$.occurrence.ids') j WHERE NEW.key='limit:'||j.value))
 OR (json_extract(a.document,'$.occurrence.kind')='counter' AND EXISTS(SELECT 1 FROM json_each(a.document,'$.occurrence.sourceIds') j WHERE NEW.key='counter:'||j.value))))
 THEN RAISE(ABORT,'Auto Sell occurrence already claimed or invalid') END;
END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_stops_insert BEFORE INSERT ON auto_sell_run_stops BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM auto_sell_run_stops WHERE (owner_id=NEW.owner_id AND id=NEW.id) OR (owner_id=NEW.owner_id AND run_id=NEW.run_id))
 OR NOT EXISTS(SELECT 1 FROM auto_sell_runs r JOIN auto_sell_run_heads h ON h.owner_id=r.owner_id AND h.run_id=r.id WHERE r.owner_id=NEW.owner_id AND r.id=NEW.run_id AND r.sha256=NEW.run_sha256 AND h.state='open')
 OR length(NEW.created_at)!=24 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) IS NOT NEW.created_at
 OR NEW.created_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 seconds') OR NEW.created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 seconds')
 THEN RAISE(ABORT,'Auto Sell stop identity changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_stops_append AFTER INSERT ON auto_sell_run_stops BEGIN
 UPDATE auto_sell_run_heads SET state='stopped',updated_at=NEW.created_at WHERE owner_id=NEW.owner_id AND run_id=NEW.run_id AND state='open';
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'Auto Sell stop head unavailable') END;
END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_preparation_starts_insert BEFORE INSERT ON auto_sell_run_preparation_starts BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM auto_sell_run_preparation_starts s WHERE s.owner_id=NEW.owner_id AND s.run_id=NEW.run_id
 AND NOT EXISTS(SELECT 1 FROM imported_swap_preparations p WHERE p.owner_id=s.owner_id AND p.id=s.preparation_id))
 THEN RAISE(ABORT,'Auto Sell run preparation remains held') END;
 SELECT CASE WHEN length(NEW.created_at)!=24 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) IS NOT NEW.created_at
 OR NEW.created_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 seconds') OR NEW.created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 seconds')
 THEN RAISE(ABORT,'Auto Sell preparation start clock invalid') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM auto_sell_run_preparation_starts WHERE (owner_id=NEW.owner_id AND attempt_id=NEW.attempt_id) OR preparation_id=NEW.preparation_id)
 OR NOT EXISTS(SELECT 1 FROM auto_sell_runs r JOIN auto_sell_run_attempts a ON a.owner_id=r.owner_id AND a.run_id=r.id JOIN auto_sell_run_heads h ON h.owner_id=r.owner_id AND h.run_id=r.id
 WHERE r.owner_id=NEW.owner_id AND r.id=NEW.run_id AND a.id=NEW.attempt_id AND a.preparation_id=NEW.preparation_id
 AND h.state='open' AND h.sequence=NEW.head_sequence AND h.head_sha256=NEW.head_sha256
 AND EXISTS(SELECT 1 FROM auto_sell_run_current_sources c WHERE c.owner_id=r.owner_id AND c.id=r.id)
 AND NOT EXISTS(SELECT 1 FROM auto_sell_run_stops s WHERE s.owner_id=r.owner_id AND s.run_id=r.id)
 AND strftime('%Y-%m-%dT%H:%M:%fZ','now')>=r.active_at AND (r.ends_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ','now')<r.ends_at)
 AND EXISTS(SELECT 1 FROM json_each(r.document,'$.limits.strategies') l WHERE json_extract(l.value,'$.id')=a.strategy_id
  AND (json_extract(l.value,'$.endsAt') IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ','now')<json_extract(l.value,'$.endsAt')))
 AND NOT EXISTS(SELECT 1 FROM imported_swap_preparations p WHERE p.id=a.preparation_id)
 ) THEN RAISE(ABORT,'Auto Sell preparation already started or source changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_preparations_insert BEFORE INSERT ON imported_swap_preparations
WHEN EXISTS(SELECT 1 FROM auto_sell_run_attempts a WHERE a.preparation_id=NEW.id)
 OR EXISTS(SELECT 1 FROM imported_swap_preparations p JOIN auto_sell_run_attempts a ON a.preparation_id=p.id WHERE p.rowid=NEW.rowid) BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM imported_swap_preparations p WHERE p.id=NEW.id)
 OR EXISTS(SELECT 1 FROM imported_swap_preparations p JOIN auto_sell_run_attempts a ON a.preparation_id=p.id WHERE p.rowid=NEW.rowid)
 OR NOT EXISTS(SELECT 1 FROM auto_sell_runs r JOIN auto_sell_run_attempts a ON a.owner_id=r.owner_id AND a.run_id=r.id
 JOIN auto_sell_run_heads h ON h.owner_id=r.owner_id AND h.run_id=r.id
 JOIN auto_sell_run_preparation_starts s ON s.owner_id=a.owner_id AND s.attempt_id=a.id AND s.preparation_id=a.preparation_id
 WHERE a.preparation_id=NEW.id AND r.owner_id=NEW.owner_id AND r.project_id=NEW.project_id AND r.project_revision=NEW.project_revision
 AND a.wallet=NEW.wallet_address AND a.wallet_revision=NEW.wallet_revision AND h.state='open'
 AND s.head_sequence=h.sequence AND s.head_sha256=h.head_sha256
 AND EXISTS(SELECT 1 FROM auto_sell_run_current_sources c WHERE c.owner_id=r.owner_id AND c.id=r.id)
 AND NOT EXISTS(SELECT 1 FROM auto_sell_run_stops z WHERE z.owner_id=r.owner_id AND z.run_id=r.id)
 AND strftime('%Y-%m-%dT%H:%M:%fZ','now')>=r.active_at AND (r.ends_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ','now')<r.ends_at)
 AND EXISTS(SELECT 1 FROM json_each(r.document,'$.limits.strategies') l WHERE json_extract(l.value,'$.id')=a.strategy_id
  AND (json_extract(l.value,'$.endsAt') IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ','now')<json_extract(l.value,'$.endsAt')))
 AND json_valid(NEW.document) AND json_type(NEW.document,'$.executionAllowed') IS 'false'
 AND json_extract(NEW.document,'$.side') IS 'Sell' AND json_extract(NEW.document,'$.wallet') IS a.wallet
 AND json_extract(NEW.document,'$.inputMint') IS json_extract(r.document,'$.profile.terms.token.mint')
 AND json_extract(NEW.document,'$.outputMint') IS 'So11111111111111111111111111111111111111112'
 AND json_extract(NEW.document,'$.inAmountRaw') IS a.input_raw
 AND json_type(NEW.document,'$.slippageBps') IS 'integer' AND json_extract(NEW.document,'$.slippageBps') BETWEEN 1 AND COALESCE(json_extract(r.document,'$.profile.terms.configuration.session.maxSlippageBps'),50)
 AND length(json_extract(NEW.document,'$.transaction.sha256'))=64 AND json_extract(NEW.document,'$.transaction.sha256') NOT GLOB '*[^a-f0-9]*'
 AND json_type(NEW.document,'$.acquisition') IS NULL AND json_type(NEW.document,'$.conditional') IS NULL AND json_type(NEW.document,'$.session') IS NULL
 ) THEN RAISE(ABORT,'Auto Sell preparation publication differs or stopped') END;
END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_preparations_no_update BEFORE UPDATE ON imported_swap_preparations
WHEN EXISTS(SELECT 1 FROM auto_sell_run_attempts a WHERE a.preparation_id IN (OLD.id,NEW.id))
 OR EXISTS(SELECT 1 FROM imported_swap_preparations p JOIN auto_sell_run_attempts a ON a.preparation_id=p.id WHERE p.rowid=NEW.rowid) BEGIN
 SELECT RAISE(ABORT,'Auto Sell original preparation is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_preparations_no_delete BEFORE DELETE ON imported_swap_preparations
WHEN EXISTS(SELECT 1 FROM auto_sell_run_attempts a WHERE a.preparation_id=OLD.id) BEGIN
 SELECT RAISE(ABORT,'Auto Sell original preparation is retained');
END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_signing_disabled BEFORE INSERT ON imported_swap_signing_intents
WHEN EXISTS(SELECT 1 FROM auto_sell_run_attempts a WHERE a.preparation_id=NEW.preparation_id) BEGIN
 SELECT RAISE(ABORT,'Auto Sell journal signing remains disabled');
END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_signing_update_disabled BEFORE UPDATE ON imported_swap_signing_intents
WHEN EXISTS(SELECT 1 FROM auto_sell_run_attempts a WHERE a.preparation_id=NEW.preparation_id) BEGIN
 SELECT RAISE(ABORT,'Auto Sell journal signing remains disabled');
END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_runs_no_update BEFORE UPDATE ON auto_sell_runs BEGIN SELECT RAISE(ABORT,'Auto Sell journal records are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_runs_no_delete BEFORE DELETE ON auto_sell_runs BEGIN SELECT RAISE(ABORT,'Auto Sell journal records are retained'); END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_attempts_no_update BEFORE UPDATE ON auto_sell_run_attempts BEGIN SELECT RAISE(ABORT,'Auto Sell journal records are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_attempts_no_delete BEFORE DELETE ON auto_sell_run_attempts BEGIN SELECT RAISE(ABORT,'Auto Sell journal records are retained'); END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_occurrences_no_update BEFORE UPDATE ON auto_sell_run_occurrences BEGIN SELECT RAISE(ABORT,'Auto Sell journal records are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_occurrences_no_delete BEFORE DELETE ON auto_sell_run_occurrences BEGIN SELECT RAISE(ABORT,'Auto Sell journal records are retained'); END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_preparation_starts_no_update BEFORE UPDATE ON auto_sell_run_preparation_starts BEGIN SELECT RAISE(ABORT,'Auto Sell journal records are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_preparation_starts_no_delete BEFORE DELETE ON auto_sell_run_preparation_starts BEGIN SELECT RAISE(ABORT,'Auto Sell journal records are retained'); END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_stops_no_update BEFORE UPDATE ON auto_sell_run_stops BEGIN SELECT RAISE(ABORT,'Auto Sell journal records are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_stops_no_delete BEFORE DELETE ON auto_sell_run_stops BEGIN SELECT RAISE(ABORT,'Auto Sell journal records are retained'); END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_heads_no_delete BEFORE DELETE ON auto_sell_run_heads BEGIN SELECT RAISE(ABORT,'Auto Sell accounting heads are retained'); END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_run_strategy_heads_no_delete BEFORE DELETE ON auto_sell_run_strategy_heads BEGIN SELECT RAISE(ABORT,'Auto Sell accounting heads are retained'); END;
