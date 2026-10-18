CREATE TABLE volume_bot_usd_targets (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 project_revision INTEGER NOT NULL CHECK(project_revision>0),
 document TEXT NOT NULL CHECK(coalesce(json_valid(document) AND json_extract(document,'$.format')='volume-usd-target-v1' AND json_extract(document,'$.id')=id AND json_extract(document,'$.projectId')=project_id AND json_extract(document,'$.projectRevision')=project_revision AND json_extract(document,'$.executionAllowed')=0 AND json_extract(document,'$.signingAllowed')=0,0)),
 expires_at TEXT NOT NULL CHECK(coalesce(expires_at=json_extract(document,'$.expiresAt'),0))
);
--> statement-breakpoint
CREATE TRIGGER volume_usd_target_immutable BEFORE UPDATE ON volume_bot_usd_targets BEGIN
 SELECT RAISE(ABORT,'USD target evidence is immutable');
END;
--> statement-breakpoint
CREATE UNIQUE INDEX volume_usd_target_single_session ON volume_bot_sessions(json_extract(plan,'$.usdTarget.id')) WHERE json_type(plan,'$.usdTarget') IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER volume_usd_session_guard BEFORE INSERT ON volume_bot_sessions
WHEN json_type(NEW.plan,'$.usdTarget') IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM volume_bot_usd_targets q WHERE q.id=json_extract(NEW.plan,'$.usdTarget.id')
 AND q.owner_id=NEW.owner_id AND q.project_id=NEW.project_id AND q.project_revision=NEW.project_revision
 AND json_extract(q.document,'$.observedAt')<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND q.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND EXISTS(SELECT 1 FROM imported_token_projects p WHERE p.owner_id=NEW.owner_id AND p.id=NEW.project_id AND p.revision=NEW.project_revision AND p.chain='Solana' AND p.archived=0)
 AND q.document=json_extract(NEW.plan,'$.usdTarget')
 AND json_extract(q.document,'$.targetVolumeLamports')=json_extract(NEW.plan,'$.terms.targetVolumeLamports')
) BEGIN
 SELECT RAISE(ABORT,'USD target is changed, expired or unavailable');
END;
--> statement-breakpoint
CREATE TRIGGER volume_session_plan_immutable BEFORE UPDATE OF owner_id,project_id,project_revision,mint,decimals,plan,plan_sha256 ON volume_bot_sessions BEGIN
 SELECT RAISE(ABORT,'Volume session plan is immutable');
END;
