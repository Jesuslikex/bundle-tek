ALTER TABLE project_shares ADD COLUMN wallet_scope TEXT;
--> statement-breakpoint
CREATE TRIGGER project_shares_scope_insert BEFORE INSERT ON project_shares BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM project_shares WHERE id=NEW.id)
 OR NEW.wallet_scope IS NULL OR typeof(NEW.wallet_scope)!='text'
 OR length(CAST(NEW.wallet_scope AS BLOB))>49152 OR NOT json_valid(NEW.wallet_scope)
 THEN RAISE(ABORT,'Share wallet scope invalid') END;
 SELECT CASE WHEN json_type(NEW.wallet_scope)!='object'
 OR (SELECT count(*) FROM json_each(NEW.wallet_scope))!=3
 OR EXISTS(SELECT 1 FROM json_each(NEW.wallet_scope) WHERE key NOT IN ('format','projectRevision','wallets'))
 OR json_extract(NEW.wallet_scope,'$.format') IS NOT 'project-share-wallet-scope-v1'
 OR json_type(NEW.wallet_scope,'$.projectRevision') IS NOT 'text'
 OR length(json_extract(NEW.wallet_scope,'$.projectRevision'))!=24
 OR strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(NEW.wallet_scope,'$.projectRevision')) IS NOT json_extract(NEW.wallet_scope,'$.projectRevision')
 OR json_type(NEW.wallet_scope,'$.wallets') IS NOT 'array'
 OR json_array_length(NEW.wallet_scope,'$.wallets')>201
 OR NOT EXISTS(SELECT 1 FROM workspace_projects p WHERE p.owner_id=NEW.owner_id AND p.id=NEW.project_id AND p.updated_at=json_extract(NEW.wallet_scope,'$.projectRevision'))
 THEN RAISE(ABORT,'Share source changed or scope invalid') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM json_each(NEW.wallet_scope,'$.wallets') w
  WHERE w.type!='object' OR (SELECT count(*) FROM json_each(w.value))!=4
  OR EXISTS(SELECT 1 FROM json_each(w.value) WHERE key NOT IN ('chain','address','revision','role'))
  OR json_type(w.value,'$.chain') IS NOT 'text'
  OR json_extract(w.value,'$.chain') NOT IN ('Solana','Robinhood','BNB','Arc','Ethereum','Base')
  OR json_type(w.value,'$.address') IS NOT 'text' OR length(json_extract(w.value,'$.address')) NOT BETWEEN 32 AND 44
  OR json_type(w.value,'$.revision') IS NOT 'integer' OR json_extract(w.value,'$.revision') NOT BETWEEN 1 AND 9007199254740990
  OR json_extract(w.value,'$.role') NOT IN ('Deployer','Recipient') OR json_type(w.value,'$.role') IS NOT 'text'
  OR NOT EXISTS(SELECT 1 FROM workspace_projects p WHERE p.owner_id=NEW.owner_id AND p.id=NEW.project_id
    AND json_extract(p.document,'$.plan.chain')=json_extract(w.value,'$.chain')
    AND json_extract(p.document,'$.options.wallets.chain')=json_extract(w.value,'$.chain')
    AND ((json_extract(w.value,'$.role')='Deployer'
      AND json_extract(p.document,'$.options.wallets.deployer.address')=json_extract(w.value,'$.address')
      AND json_extract(p.document,'$.options.wallets.deployer.revision')=json_extract(w.value,'$.revision'))
     OR (json_extract(w.value,'$.role')='Recipient' AND EXISTS(SELECT 1 FROM json_each(p.document,'$.options.wallets.recipients') r
      WHERE json_extract(r.value,'$.address')=json_extract(w.value,'$.address')
       AND json_extract(r.value,'$.revision')=json_extract(w.value,'$.revision')))))
 ) OR EXISTS(SELECT 1 FROM json_each(NEW.wallet_scope,'$.wallets') w GROUP BY json_extract(w.value,'$.chain'),json_extract(w.value,'$.address') HAVING count(*)>1)
 THEN RAISE(ABORT,'Share wallet scope invalid or source changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER project_shares_scope_immutable BEFORE UPDATE ON project_shares BEGIN
 SELECT CASE WHEN NEW.wallet_scope IS NOT OLD.wallet_scope THEN RAISE(ABORT,'Share wallet scope is immutable') END;
END;
