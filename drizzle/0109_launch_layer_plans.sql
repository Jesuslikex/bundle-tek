CREATE TABLE launch_layer_plans (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 project_revision TEXT NOT NULL,
 source_document TEXT NOT NULL CHECK(json_valid(source_document)),
 document TEXT NOT NULL CHECK(length(CAST(document AS BLOB))<=524288 AND json_valid(document)
 AND json_extract(document,'$.format') IS 'owned-launch-layer-plan-v1'
 AND json_type(document,'$.envelope.terms.fundingAllowed') IS 'false'
 AND json_type(document,'$.envelope.terms.signingAllowed') IS 'false'
 AND json_type(document,'$.envelope.terms.executionAllowed') IS 'false'),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
 created_at TEXT NOT NULL CHECK(coalesce(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at,0))
);
--> statement-breakpoint
CREATE INDEX launch_layer_plans_owner ON launch_layer_plans(owner_id,project_id,created_at,id);
--> statement-breakpoint
CREATE UNIQUE INDEX launch_layer_plans_exact_snapshot ON launch_layer_plans(owner_id,project_id,sha256);
--> statement-breakpoint
CREATE TRIGGER launch_layer_plan_admission BEFORE INSERT ON launch_layer_plans
WHEN NOT coalesce((
 WITH refs(role,pos,member) AS (
 SELECT stage.value,entry.key,entry.value
 FROM json_each('["funder","developer","front","back","temporary","holders"]') stage
 JOIN json_each(iif(stage.value IN ('funder','developer'),json_array(json_extract(NEW.document,'$.envelope.terms.roles.'||stage.value)),json_extract(NEW.document,'$.envelope.terms.roles.'||stage.value))) entry
 WHERE stage.value<>'developer' OR json_type(NEW.document,'$.envelope.terms.roles.developer')='object'
 )
 SELECT length(NEW.id)=36 AND length(replace(NEW.id,'-',''))=32 AND replace(NEW.id,'-','') NOT GLOB '*[^a-f0-9]*'
 AND substr(NEW.id,9,1)='-' AND substr(NEW.id,14,1)='-' AND substr(NEW.id,19,1)='-' AND substr(NEW.id,24,1)='-'
 AND json_extract(NEW.document,'$.sourceDocument')=NEW.source_document
 AND json_extract(NEW.document,'$.selection.projectId')=NEW.project_id
 AND json_extract(NEW.document,'$.selection.projectUpdatedAt')=NEW.project_revision
 AND json_extract(NEW.document,'$.context.ownerId')=NEW.owner_id
 AND json_extract(NEW.document,'$.context.savedPlan.updatedAt')=NEW.project_revision
 AND json_extract(NEW.document,'$.envelope.terms.format')='launch-layer-terms-v1'
 AND json_extract(NEW.document,'$.envelope.terms.protocol')='buyback'
 AND json_extract(NEW.document,'$.envelope.terms.binding.ownerId')=NEW.owner_id
 AND json_extract(NEW.document,'$.envelope.terms.binding.savedPlanUpdatedAt')=NEW.project_revision
 AND json_extract(NEW.document,'$.envelope.terms.binding.target.kind')=json_extract(NEW.document,'$.selection.target.kind')
 AND json_extract(NEW.document,'$.context.target.kind')=json_extract(NEW.document,'$.selection.target.kind')
 AND json_extract(NEW.document,'$.context.target.mint')=json_extract(NEW.document,'$.envelope.terms.binding.target.mint')
 AND json_extract(NEW.source_document,'$.plan.chain')='Solana'
 AND json_extract(NEW.source_document,'$.plan.mode')='Block-0'
 AND json_extract(NEW.source_document,'$.plan.launchpad') IN ('PumpFun','StonkFun')
 AND json_extract(NEW.document,'$.envelope.terms.launchpad')=json_extract(NEW.source_document,'$.plan.launchpad')
 AND json_extract(NEW.source_document,'$.options.wallets.chain')='Solana'
 AND EXISTS(SELECT 1 FROM workspace_projects p WHERE p.owner_id=NEW.owner_id AND p.id=NEW.project_id AND p.archived=0 AND p.updated_at=NEW.project_revision AND p.document=NEW.source_document)
 AND json_type(NEW.document,'$.envelope.terms.roles.front')='array' AND json_array_length(NEW.document,'$.envelope.terms.roles.front') BETWEEN 1 AND 200
 AND json_type(NEW.document,'$.envelope.terms.roles.back')='array' AND json_array_length(NEW.document,'$.envelope.terms.roles.back')<=200
 AND json_type(NEW.document,'$.envelope.terms.roles.temporary')='array' AND json_array_length(NEW.document,'$.envelope.terms.roles.temporary')<=200
 AND json_type(NEW.document,'$.envelope.terms.roles.holders')='array'
 AND json_array_length(NEW.document,'$.envelope.terms.roles.holders')=json_extract(NEW.source_document,'$.plan.holderCount')
 AND json_array_length(NEW.source_document,'$.options.wallets.recipients')=json_extract(NEW.source_document,'$.plan.holderCount')
 AND (json_extract(NEW.source_document,'$.plan.launchpad')<>'StonkFun' OR (json_array_length(NEW.document,'$.envelope.terms.roles.front')<=12 AND json_array_length(NEW.document,'$.envelope.terms.roles.back')=0 AND json_array_length(NEW.document,'$.envelope.terms.roles.temporary')=0))
 AND ((json_extract(NEW.document,'$.selection.target.kind')='new'
 AND json_extract(NEW.document,'$.selection.target.mint')=json_extract(NEW.document,'$.context.target.mint')
 AND (SELECT count(*) FROM refs WHERE role='developer')=1
 AND json_type(NEW.source_document,'$.options.wallets.deployer')='object')
 OR (json_extract(NEW.document,'$.selection.target.kind')='imported'
 AND (SELECT count(*) FROM refs WHERE role='developer')=0
 AND json_type(NEW.source_document,'$.plan.scheduled')='true'
 AND EXISTS(SELECT 1 FROM imported_token_projects p WHERE p.owner_id=NEW.owner_id AND p.id=json_extract(NEW.document,'$.selection.target.projectId') AND p.chain='Solana' AND p.archived=0
 AND p.revision=json_extract(NEW.document,'$.selection.target.revision') AND p.document=json_extract(NEW.document,'$.targetDocument')
 AND p.address=json_extract(NEW.document,'$.context.target.mint') AND p.address=json_extract(p.document,'$.token.address') AND json_extract(p.document,'$.token.chain')='Solana')))
 AND (SELECT count(*) FROM refs) BETWEEN 3 AND 500
 AND (SELECT count(*) FROM refs)=(SELECT count(DISTINCT json_extract(member,'$.wallet.address')) FROM refs)
 AND NOT EXISTS(SELECT 1 FROM refs r LEFT JOIN workspace_wallets w ON w.owner_id=NEW.owner_id AND w.chain='Solana' AND w.address=json_extract(r.member,'$.wallet.address')
 LEFT JOIN wallet_folders f ON f.owner_id=w.owner_id AND f.chain=w.chain AND f.id=coalesce(json_extract(r.member,'$.wallet.folderId'),w.folder_id)
 WHERE NOT coalesce(w.archived=0 AND w.revision=json_extract(r.member,'$.wallet.revision')
 AND ((json_extract(r.member,'$.wallet.root')=1 AND json_extract(r.member,'$.wallet.folderRevision')=0 AND json_extract(r.member,'$.wallet.folderId') IS NULL)
 OR (json_extract(r.member,'$.wallet.root') IS NULL AND json_extract(r.member,'$.wallet.folderId') IS NULL AND json_extract(r.member,'$.wallet.folderRevision')=0 AND json_array_length(coalesce(w.folder_ids,iif(w.folder_id='',json('[]'),json_array(w.folder_id))))=0)
 OR (json_extract(r.member,'$.wallet.root') IS NULL AND f.archived=0 AND f.revision=json_extract(r.member,'$.wallet.folderRevision') AND f.id IN(SELECT value FROM json_each(coalesce(w.folder_ids,iif(w.folder_id='',json('[]'),json_array(w.folder_id))))))),0))
 AND NOT EXISTS(SELECT 1 FROM refs r WHERE r.role IN ('developer','holders') AND NOT coalesce(
 json_extract(r.member,'$.wallet.address')=json_extract(NEW.source_document,'$.options.wallets.'||iif(r.role='developer','deployer','recipients['||r.pos||']')||'.address')
 AND json_extract(r.member,'$.wallet.revision')=json_extract(NEW.source_document,'$.options.wallets.'||iif(r.role='developer','deployer','recipients['||r.pos||']')||'.revision')
 AND json_extract(r.member,'$.wallet.folderRevision')=json_extract(NEW.source_document,'$.options.wallets.'||iif(r.role='developer','deployer','recipients['||r.pos||']')||'.folderRevision')
 AND coalesce(json_extract(r.member,'$.wallet.folderId'),'')=coalesce(json_extract(NEW.source_document,'$.options.wallets.'||iif(r.role='developer','deployer','recipients['||r.pos||']')||'.folderId'),'')
 AND coalesce(json_extract(r.member,'$.wallet.root'),0)=coalesce(json_extract(NEW.source_document,'$.options.wallets.'||iif(r.role='developer','deployer','recipients['||r.pos||']')||'.root'),0),0))
 AND (EXISTS(SELECT 1 FROM launch_layer_plans p WHERE p.owner_id=NEW.owner_id AND p.project_id=NEW.project_id AND p.sha256=NEW.sha256)
 OR (SELECT count(*) FROM launch_layer_plans p WHERE p.owner_id=NEW.owner_id AND p.project_id=NEW.project_id)<100)
 ),0)
BEGIN SELECT RAISE(ABORT,'Layer plan requires the current owned project, target and wallet references'); END;
--> statement-breakpoint
CREATE TRIGGER launch_layer_plan_immutable BEFORE UPDATE ON launch_layer_plans BEGIN SELECT RAISE(ABORT,'Layer plan is immutable; save a new plan'); END;
--> statement-breakpoint
CREATE TRIGGER launch_layer_plan_retain BEFORE DELETE ON launch_layer_plans BEGIN SELECT RAISE(ABORT,'Retain historical layer planning'); END;
