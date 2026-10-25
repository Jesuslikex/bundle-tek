ALTER TABLE project_shares ADD COLUMN metadata_edit INTEGER NOT NULL DEFAULT 0 CHECK(metadata_edit IN (0,1));
--> statement-breakpoint
CREATE TRIGGER project_shares_metadata_permission_immutable BEFORE UPDATE ON project_shares BEGIN
 SELECT CASE WHEN NEW.metadata_edit IS NOT OLD.metadata_edit THEN RAISE(ABORT,'Metadata edit permission is immutable') END;
END;
--> statement-breakpoint
CREATE TABLE project_collaboration_metadata_edits (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL,
 editor_id TEXT NOT NULL,
 share_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 source_document TEXT NOT NULL CHECK(json_valid(source_document)),
 before_revision TEXT NOT NULL,
 after_revision TEXT NOT NULL,
 values_before TEXT NOT NULL CHECK(json_valid(values_before)),
 values_after TEXT NOT NULL CHECK(json_valid(values_after)),
 review_hash TEXT NOT NULL CHECK(length(review_hash)=64 AND review_hash NOT GLOB '*[^0-9a-f]*'),
 created_at TEXT NOT NULL,
 CHECK(owner_id<>editor_id),
 CHECK(length(CAST(source_document AS BLOB))<=131072),
 CHECK(length(CAST(values_before AS BLOB))<=2048 AND length(CAST(values_after AS BLOB))<=2048)
);
--> statement-breakpoint
CREATE INDEX project_collaboration_metadata_edits_owner ON project_collaboration_metadata_edits(owner_id,project_id,created_at DESC,id DESC);
--> statement-breakpoint
CREATE INDEX project_collaboration_metadata_edits_editor ON project_collaboration_metadata_edits(editor_id,id);
--> statement-breakpoint
CREATE TRIGGER project_collaboration_metadata_edits_admission BEFORE INSERT ON project_collaboration_metadata_edits BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM project_collaboration_metadata_edits WHERE id=NEW.id)
 THEN RAISE(ABORT,'Metadata edit ID already used') END;
 SELECT CASE WHEN length(NEW.id)!=36 OR length(replace(NEW.id,'-',''))!=32 OR NEW.id GLOB '*[^0-9a-f-]*'
 OR substr(NEW.id,9,1)!='-' OR substr(NEW.id,14,1)!='-' OR substr(NEW.id,19,1)!='-' OR substr(NEW.id,24,1)!='-'
 OR length(NEW.before_revision)!=24 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.before_revision) IS NOT NEW.before_revision
 OR length(NEW.after_revision)!=24 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.after_revision) IS NOT NEW.after_revision
 OR length(NEW.created_at)!=24 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) IS NOT NEW.created_at
 OR NEW.after_revision<=NEW.before_revision
 THEN RAISE(ABORT,'Metadata edit record invalid') END;
 SELECT CASE WHEN (SELECT count(*) FROM project_collaboration_metadata_edits WHERE owner_id=NEW.owner_id AND project_id=NEW.project_id)>=1000
 THEN RAISE(ABORT,'Metadata edit capacity reached') END;
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM project_shares s JOIN workspace_projects p ON p.owner_id=s.owner_id AND p.id=s.project_id
  WHERE s.id=NEW.share_id AND s.owner_id=NEW.owner_id AND s.member_id=NEW.editor_id AND s.project_id=NEW.project_id
   AND s.accepted_at IS NOT NULL AND s.metadata_edit=1 AND s.revoked_at IS NULL
   AND (s.expires_at IS NULL OR s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   AND p.archived=0 AND p.updated_at=NEW.before_revision AND p.document=NEW.source_document
 ) THEN RAISE(ABORT,'Metadata edit permission or project changed') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM (SELECT NEW.values_before AS value UNION ALL SELECT NEW.values_after) v
  WHERE json_type(v.value)!='object' OR (SELECT count(*) FROM json_each(v.value))!=3
   OR EXISTS(SELECT 1 FROM json_each(v.value) WHERE key NOT IN ('tokenName','ticker','description'))
   OR json_type(v.value,'$.tokenName') IS NOT 'text' OR length(json_extract(v.value,'$.tokenName'))>64
   OR trim(json_extract(v.value,'$.tokenName')) IS NOT json_extract(v.value,'$.tokenName')
   OR json_type(v.value,'$.ticker') IS NOT 'text' OR length(json_extract(v.value,'$.ticker')) NOT BETWEEN 1 AND 16
   OR json_extract(v.value,'$.ticker') GLOB '*[^A-Z0-9]*'
   OR json_type(v.value,'$.description') IS NOT 'text' OR length(json_extract(v.value,'$.description'))>280
   OR trim(json_extract(v.value,'$.description')) IS NOT json_extract(v.value,'$.description')
 ) OR json_extract(NEW.values_before,'$.tokenName') IS NOT json_extract(NEW.source_document,'$.plan.tokenName')
 OR json_extract(NEW.values_before,'$.ticker') IS NOT json_extract(NEW.source_document,'$.plan.ticker')
 OR json_extract(NEW.values_before,'$.description') IS NOT json_extract(NEW.source_document,'$.plan.description')
 OR (json_extract(NEW.values_before,'$.tokenName')=json_extract(NEW.values_after,'$.tokenName')
  AND json_extract(NEW.values_before,'$.ticker')=json_extract(NEW.values_after,'$.ticker')
  AND json_extract(NEW.values_before,'$.description')=json_extract(NEW.values_after,'$.description'))
 THEN RAISE(ABORT,'Metadata edit text invalid or unchanged') END;
 -- Only the service's fixed-order canonical JSON spelling is admitted. In
 -- particular, extracting an isolated surrogate and serializing it again must
 -- never silently change the approved text before json_set stores it.
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM (SELECT NEW.values_before AS value UNION ALL SELECT NEW.values_after) v
  WHERE v.value IS NOT json_object('tokenName',json_extract(v.value,'$.tokenName'),
   'ticker',json_extract(v.value,'$.ticker'),'description',json_extract(v.value,'$.description'))
 ) THEN RAISE(ABORT,'Metadata edit UTF16 canonical text invalid') END;
 -- JavaScript counts UTF-16 units; SQLite length() counts Unicode code points.
 -- Bound the short text first, then count supplementary characters as two units.
 SELECT CASE WHEN EXISTS(
  WITH RECURSIVE texts(value,minimum,maximum) AS (
   SELECT json_extract(NEW.values_before,'$.tokenName'),2,64
   UNION ALL SELECT json_extract(NEW.values_after,'$.tokenName'),2,64
   UNION ALL SELECT json_extract(NEW.values_before,'$.description'),0,280
   UNION ALL SELECT json_extract(NEW.values_after,'$.description'),0,280
  ), units(value,position,total,minimum,maximum) AS (
   SELECT value,1,0,minimum,maximum FROM texts
   UNION ALL SELECT value,position+1,total+ CASE WHEN unicode(substr(value,position,1))>65535 THEN 2 ELSE 1 END,minimum,maximum
    FROM units WHERE position<=length(value)
  ) SELECT 1 FROM units WHERE (position>length(value) AND (total<minimum OR total>maximum OR instr(value,char(0))>0))
   OR (position<=length(value) AND unicode(substr(value,position,1)) BETWEEN 55296 AND 57343)
 ) THEN RAISE(ABORT,'Metadata edit UTF16 text limit invalid') END;
 -- Include the owner's save envelope and reserve its fixed-size mutation ID.
 -- Literal legacy escape sequences may be counted conservatively; never widen
 -- the owner's 24,000 UTF-16-unit budget or rewrite other saved project fields.
 SELECT CASE WHEN EXISTS(
  WITH RECURSIVE candidate(value) AS (
   SELECT json_set(NEW.source_document,
    '$.plan.tokenName',json_extract(NEW.values_after,'$.tokenName'),
    '$.plan.ticker',json_extract(NEW.values_after,'$.ticker'),
    '$.plan.description',json_extract(NEW.values_after,'$.description'),
    '$.id',NEW.project_id,'$.archived',json('false'),
    '$.expectedUpdatedAt',NEW.before_revision,'$.mutationId',NEW.id)
  ), units(value,position,total) AS (
   SELECT value,1,0 FROM candidate WHERE length(value)<=24000
   UNION ALL SELECT value,position+1,total+ CASE WHEN unicode(substr(value,position,1))>65535 THEN 2 ELSE 1 END
    FROM units WHERE position<=length(value)
  ) SELECT 1 FROM candidate WHERE length(value)>24000
   UNION ALL SELECT 1 FROM units WHERE position>length(value) AND total>24000
 ) THEN RAISE(ABORT,'Metadata edit owner document limit exceeded') END;
 SELECT CASE WHEN (json_type(NEW.source_document,'$.options.wallets') IS NOT NULL
  AND (json_extract(NEW.source_document,'$.options.wallets.chain') IS NOT json_extract(NEW.source_document,'$.plan.chain')
   OR json_array_length(NEW.source_document,'$.options.wallets.recipients')>json_extract(NEW.source_document,'$.plan.holderCount')))
 OR EXISTS(
  SELECT 1 FROM (
   SELECT 'Deployer' AS role,json_extract(NEW.source_document,'$.options.wallets.deployer') AS value
    WHERE json_type(NEW.source_document,'$.options.wallets.deployer')='object'
   UNION ALL
   SELECT 'Recipient',value FROM json_each(NEW.source_document,'$.options.wallets.recipients')
  ) wanted
  WHERE NOT EXISTS(
   SELECT 1 FROM workspace_wallets w
   LEFT JOIN wallet_folders f ON f.owner_id=w.owner_id AND f.id=COALESCE(json_extract(wanted.value,'$.folderId'),w.folder_id)
    AND f.id IN(SELECT value FROM json_each(COALESCE(w.folder_ids,json_array(w.folder_id)))) AND f.chain=w.chain
   WHERE w.owner_id=NEW.owner_id AND w.chain=json_extract(NEW.source_document,'$.plan.chain') AND w.address=json_extract(wanted.value,'$.address')
    AND w.archived=0 AND w.role=wanted.role AND w.revision=json_extract(wanted.value,'$.revision')
    AND ((json_extract(wanted.value,'$.root')=1 AND json_extract(wanted.value,'$.folderRevision')=0 AND json_extract(wanted.value,'$.folderId') IS NULL)
     OR (json_array_length(COALESCE(w.folder_ids,json_array(w.folder_id)))=0 AND json_extract(wanted.value,'$.folderRevision')=0 AND json_extract(wanted.value,'$.folderId') IS NULL)
     OR (f.archived=0 AND f.revision=json_extract(wanted.value,'$.folderRevision')))
  )
 ) THEN RAISE(ABORT,'Metadata edit wallet selection changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER project_collaboration_metadata_edits_apply AFTER INSERT ON project_collaboration_metadata_edits BEGIN
 UPDATE workspace_projects SET document=json_set(NEW.source_document,
  '$.plan.tokenName',json_extract(NEW.values_after,'$.tokenName'),
  '$.plan.ticker',json_extract(NEW.values_after,'$.ticker'),
  '$.plan.description',json_extract(NEW.values_after,'$.description')),
  updated_at=NEW.after_revision,mutation_id=NEW.id
 WHERE owner_id=NEW.owner_id AND id=NEW.project_id AND archived=0 AND updated_at=NEW.before_revision AND document=NEW.source_document;
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'Metadata edit project changed') END;
 INSERT INTO project_events(owner_id,project_id,name,chain,launchpad,type,changes,revision,created_at)
 VALUES(NEW.owner_id,NEW.project_id,json_extract(NEW.values_after,'$.tokenName'),
  json_extract(NEW.source_document,'$.plan.chain'),json_extract(NEW.source_document,'$.plan.launchpad'),'project.saved',
  (SELECT json_group_array(label) FROM (
   SELECT 'collaborator: name' AS label WHERE json_extract(NEW.values_before,'$.tokenName')!=json_extract(NEW.values_after,'$.tokenName')
   UNION ALL SELECT 'collaborator: symbol' WHERE json_extract(NEW.values_before,'$.ticker')!=json_extract(NEW.values_after,'$.ticker')
   UNION ALL SELECT 'collaborator: description' WHERE json_extract(NEW.values_before,'$.description')!=json_extract(NEW.values_after,'$.description')
  )),NEW.after_revision,NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER project_collaboration_metadata_edits_immutable BEFORE UPDATE ON project_collaboration_metadata_edits BEGIN
 SELECT RAISE(ABORT,'Metadata edit receipts are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER project_collaboration_metadata_edits_no_delete BEFORE DELETE ON project_collaboration_metadata_edits BEGIN
 SELECT RAISE(ABORT,'Metadata edit receipts are immutable');
END;
