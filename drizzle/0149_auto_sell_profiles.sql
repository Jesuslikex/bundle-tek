CREATE TABLE auto_sell_profiles (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 128),
 project_id TEXT NOT NULL,
 project_revision INTEGER NOT NULL CHECK(project_revision>0),
 profile_id TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 1000),
 document TEXT NOT NULL CHECK(length(CAST(document AS BLOB))<=263168 AND json_valid(document)
  AND json_extract(document,'$.format') IS 'auto-sell-profile-v1'
  AND json_type(document,'$.signingAllowed') IS 'false'
  AND json_type(document,'$.executionAllowed') IS 'false'
  AND json_type(document,'$.automaticResumeAllowed') IS 'false'
  AND json_extract(document,'$.id') IS id
  AND json_extract(document,'$.profileId') IS profile_id
  AND json_extract(document,'$.version') IS version
  AND json_extract(document,'$.terms.projectId') IS project_id
  AND json_extract(document,'$.terms.projectRevision') IS project_revision
  AND json_extract(document,'$.sha256') IS sha256
  AND json_extract(document,'$.createdAt') IS created_at),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
 created_at TEXT NOT NULL CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at),
 UNIQUE(owner_id,project_id,profile_id,version)
);
--> statement-breakpoint
CREATE INDEX auto_sell_profiles_owner ON auto_sell_profiles(owner_id,project_id,created_at,id);
--> statement-breakpoint
CREATE TRIGGER auto_sell_profiles_insert BEFORE INSERT ON auto_sell_profiles BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM imported_token_projects p WHERE p.owner_id=NEW.owner_id AND p.id=NEW.project_id
  AND p.revision=NEW.project_revision AND p.archived=0 AND p.chain='Solana'
  AND p.address IS json_extract(NEW.document,'$.terms.token.mint')
  AND json_valid(p.document) AND json_extract(p.document,'$.token.chain') IS 'Solana'
  AND json_extract(p.document,'$.token.address') IS json_extract(NEW.document,'$.terms.token.mint')
  AND json_extract(p.document,'$.token.decimals') IS json_extract(NEW.document,'$.terms.token.decimals')
  AND json_extract(p.document,'$.token.totalSupplyRaw') IS json_extract(NEW.document,'$.terms.token.totalSupplyRaw'))
 THEN RAISE(ABORT,'Auto Sell profile project changed') END;
 SELECT CASE WHEN json_type(NEW.document,'$.terms.wallets') IS NOT 'array'
  OR json_array_length(NEW.document,'$.terms.wallets') NOT BETWEEN 1 AND 500
  OR (SELECT COUNT(DISTINCT json_extract(j.value,'$.address')) FROM json_each(NEW.document,'$.terms.wallets') j)<>json_array_length(NEW.document,'$.terms.wallets')
  OR EXISTS(SELECT 1 FROM json_each(NEW.document,'$.terms.wallets') j WHERE NOT EXISTS(
   SELECT 1 FROM workspace_wallets w WHERE w.owner_id=NEW.owner_id AND w.chain='Solana' AND w.archived=0
    AND w.address=json_extract(j.value,'$.address') AND w.revision=json_extract(j.value,'$.revision')))
 THEN RAISE(ABORT,'Auto Sell profile wallets changed') END;
 SELECT CASE WHEN NEW.version<>(SELECT COALESCE(MAX(version),0)+1 FROM auto_sell_profiles
  WHERE owner_id=NEW.owner_id AND project_id=NEW.project_id AND profile_id=NEW.profile_id)
 THEN RAISE(ABORT,'Auto Sell profile version changed') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM auto_sell_profiles WHERE owner_id=NEW.owner_id AND project_id=NEW.project_id)>=1000
  OR (NOT EXISTS(SELECT 1 FROM auto_sell_profiles WHERE owner_id=NEW.owner_id AND project_id=NEW.project_id AND profile_id=NEW.profile_id)
   AND (SELECT COUNT(DISTINCT profile_id) FROM auto_sell_profiles WHERE owner_id=NEW.owner_id AND project_id=NEW.project_id)>=100)
 THEN RAISE(ABORT,'Auto Sell profile storage full') END;
END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_profiles_immutable BEFORE UPDATE ON auto_sell_profiles BEGIN
 SELECT RAISE(ABORT,'Auto Sell profile versions are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER auto_sell_profiles_retained BEFORE DELETE ON auto_sell_profiles BEGIN
 SELECT RAISE(ABORT,'Auto Sell profile versions are retained');
END;
