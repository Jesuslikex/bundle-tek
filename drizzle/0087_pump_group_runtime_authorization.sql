CREATE TABLE pump_group_runtime_reviews (
 id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, review_id TEXT NOT NULL REFERENCES pump_launch_reviews(id),
 context_sha256 TEXT NOT NULL, identity_sha256 TEXT NOT NULL, preview TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX pump_group_runtime_owner ON pump_group_runtime_reviews(owner_id,review_id,id);
--> statement-breakpoint
CREATE TRIGGER pump_group_runtime_insert BEFORE INSERT ON pump_group_runtime_reviews BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pump_launch_reviews r JOIN workspace_projects p ON p.id=r.project_id AND p.owner_id=r.owner_id
 WHERE r.id=NEW.review_id AND r.owner_id=NEW.owner_id AND r.state IN ('review','approved') AND r.signed IS NULL AND r.receipt IS NULL
 AND p.document=r.project_document AND p.updated_at=json_extract(r.terms,'$.updatedAt') AND p.archived=0 AND julianday(r.expires_at)>julianday('now')
 AND json_extract(r.review,'$.format')='pump-launch-group-review-v1' AND json_extract(r.review,'$.contextSha256')=NEW.context_sha256
 AND json_extract(NEW.preview,'$.format')='pump-group-runtime-preview-v1' AND json_extract(NEW.preview,'$.id')=NEW.id AND json_extract(NEW.preview,'$.reviewId')=r.id
 AND json_extract(NEW.preview,'$.contextSha256')=NEW.context_sha256 AND json_extract(NEW.preview,'$.manifestSha256')=json_extract(r.review,'$.manifestSha256')
 AND json_extract(NEW.preview,'$.simulationSha256')=json_extract(r.review,'$.simulationSha256') AND json_extract(NEW.preview,'$.identitySha256')=NEW.identity_sha256
 AND json_extract(NEW.preview,'$.codeIdentityVerified')=1 AND json_extract(NEW.preview,'$.semanticAuditEstablished')=0
 AND json_extract(NEW.preview,'$.signingAllowed')=0 AND json_extract(NEW.preview,'$.executionAllowed')=0
 AND json_extract(NEW.preview,'$.createdAt')=NEW.created_at AND json_extract(NEW.preview,'$.expiresAt')=NEW.expires_at
 AND json_type(NEW.preview,'$.programs')='array' AND json_array_length(NEW.preview,'$.programs') BETWEEN 1 AND 16
 AND length(NEW.identity_sha256)=64 AND NEW.identity_sha256 NOT GLOB '*[^a-f0-9]*'
 AND julianday('now')-julianday(NEW.created_at) BETWEEN 0 AND 5.0/86400 AND julianday(NEW.expires_at)>julianday('now')
 AND julianday(NEW.expires_at)<=julianday(r.expires_at) AND julianday(NEW.expires_at)-julianday(NEW.created_at)<=30.001/86400)
 THEN RAISE(ABORT,'Exact live owned runtime preview required') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.preview,'$.programs') WHERE json_type(value,'$.address')!='text' OR json_type(value,'$.loader')!='text' OR json_type(value,'$.codeBytes')!='integer' OR json_extract(value,'$.codeBytes') NOT BETWEEN 1 AND 10485760 OR length(json_extract(value,'$.codeSha256'))!=64 OR json_extract(value,'$.codeSha256') GLOB '*[^a-f0-9]*') THEN RAISE(ABORT,'Complete program code identities required') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_group_runtime_no_update BEFORE UPDATE ON pump_group_runtime_reviews BEGIN SELECT RAISE(ABORT,'Immutable runtime review'); END;
--> statement-breakpoint
CREATE TRIGGER pump_group_runtime_no_delete BEFORE DELETE ON pump_group_runtime_reviews BEGIN SELECT RAISE(ABORT,'Runtime review history retained'); END;
--> statement-breakpoint
CREATE TABLE pump_group_signing_authorizations (
 id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, review_id TEXT NOT NULL REFERENCES pump_launch_reviews(id), preview_id TEXT NOT NULL REFERENCES pump_group_runtime_reviews(id),
 context_sha256 TEXT NOT NULL, identity_sha256 TEXT NOT NULL, consent TEXT NOT NULL, code_consent TEXT NOT NULL, authorization TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX pump_group_signing_auth_owner ON pump_group_signing_authorizations(owner_id,review_id,id);
--> statement-breakpoint
CREATE TRIGGER pump_group_signing_auth_insert BEFORE INSERT ON pump_group_signing_authorizations BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pump_launch_reviews r JOIN pump_group_runtime_reviews v ON v.review_id=r.id AND v.owner_id=r.owner_id JOIN pump_group_approvals a ON a.review_id=r.id AND a.owner_id=r.owner_id JOIN workspace_projects p ON p.id=r.project_id AND p.owner_id=r.owner_id
 WHERE r.id=NEW.review_id AND r.owner_id=NEW.owner_id AND r.state='approved' AND r.signed IS NULL AND r.receipt IS NULL AND v.id=NEW.preview_id
 AND p.document=r.project_document AND p.updated_at=json_extract(r.terms,'$.updatedAt') AND p.archived=0 AND julianday(r.expires_at)>julianday('now')
 AND v.context_sha256=NEW.context_sha256 AND NEW.context_sha256=json_extract(r.review,'$.contextSha256') AND v.identity_sha256=NEW.identity_sha256
 AND a.consent=NEW.consent AND a.context_sha256=NEW.context_sha256 AND a.manifest_sha256=json_extract(r.review,'$.manifestSha256') AND a.simulation_sha256=json_extract(r.review,'$.simulationSha256')
 AND julianday(v.expires_at)>julianday('now') AND json_extract(NEW.code_consent,'$.approved')=1 AND json_extract(NEW.code_consent,'$.previewId')=v.id AND json_extract(NEW.code_consent,'$.identitySha256')=v.identity_sha256
 AND json_extract(NEW.code_consent,'$.acknowledgeUpgradeableCode')=1 AND json_extract(NEW.code_consent,'$.acknowledgeNoSemanticAudit')=1
 AND json_extract(NEW.authorization,'$.format')='pump-group-signing-authorization-v1' AND json_extract(NEW.authorization,'$.id')=NEW.id AND json_extract(NEW.authorization,'$.reviewId')=r.id
 AND json_extract(NEW.authorization,'$.previewId')=v.id AND json_extract(NEW.authorization,'$.contextSha256')=NEW.context_sha256 AND json_extract(NEW.authorization,'$.manifestSha256')=json_extract(r.review,'$.manifestSha256')
 AND json_extract(NEW.authorization,'$.simulationSha256')=json_extract(r.review,'$.simulationSha256') AND json_extract(NEW.authorization,'$.identitySha256')=NEW.identity_sha256
 AND json_extract(NEW.authorization,'$.scope')='sign-complete-group-only' AND json_extract(NEW.authorization,'$.signingAllowed')=1
 AND json_extract(NEW.authorization,'$.executionAllowed')=0 AND json_extract(NEW.authorization,'$.submissionAllowed')=0 AND json_extract(NEW.authorization,'$.semanticAuditEstablished')=0
 AND json_extract(NEW.authorization,'$.createdAt')=NEW.created_at AND json_extract(NEW.authorization,'$.expiresAt')=NEW.expires_at
 AND julianday('now')-julianday(NEW.created_at) BETWEEN 0 AND 5.0/86400 AND julianday(NEW.expires_at)>julianday('now')
 AND julianday(NEW.expires_at)<=julianday(r.expires_at) AND julianday(NEW.expires_at)-julianday(NEW.created_at)<=5.001/86400)
 THEN RAISE(ABORT,'Exact owned code and group approval required') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pump_launch_reviews r JOIN workspace_wallets w ON w.owner_id=r.owner_id AND w.address=r.payer JOIN wallet_ownership_proofs o ON o.owner_id=w.owner_id AND o.chain=w.chain AND o.address=w.address
 WHERE r.id=NEW.review_id AND w.chain='Solana' AND w.role='Deployer' AND w.archived=0 AND w.revision=json_extract(r.terms,'$.payerRevision')
 AND (json_extract(r.project_document,'$.options.wallets.deployer.root')=1 OR (json_extract(r.project_document,'$.options.wallets.deployer.folderRevision')=0 AND json_extract(r.project_document,'$.options.wallets.deployer.folderId') IS NULL AND COALESCE(w.folder_ids,CASE WHEN w.folder_id='' THEN '[]' ELSE json_array(w.folder_id) END)='[]') OR EXISTS(SELECT 1 FROM wallet_folders f WHERE f.owner_id=w.owner_id AND f.chain='Solana' AND f.archived=0 AND f.id=COALESCE(json_extract(r.project_document,'$.options.wallets.deployer.folderId'),w.folder_id) AND f.revision=json_extract(r.project_document,'$.options.wallets.deployer.folderRevision') AND EXISTS(SELECT 1 FROM json_each(COALESCE(w.folder_ids,json_array(w.folder_id))) WHERE value=f.id))))
 THEN RAISE(ABORT,'Runtime deployer ownership changed') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pump_launch_reviews r,json_each(r.project_document,'$.options.wallets.recipients') ref WHERE r.id=NEW.review_id AND r.owner_id=NEW.owner_id AND NOT EXISTS(SELECT 1 FROM workspace_wallets w JOIN wallet_ownership_proofs o ON o.owner_id=w.owner_id AND o.chain=w.chain AND o.address=w.address WHERE w.owner_id=r.owner_id AND w.chain='Solana' AND w.role='Recipient' AND w.archived=0 AND w.address=json_extract(ref.value,'$.address') AND w.revision=json_extract(ref.value,'$.revision') AND (json_extract(ref.value,'$.root')=1 OR (json_extract(ref.value,'$.folderRevision')=0 AND json_extract(ref.value,'$.folderId') IS NULL AND COALESCE(w.folder_ids,CASE WHEN w.folder_id='' THEN '[]' ELSE json_array(w.folder_id) END)='[]') OR EXISTS(SELECT 1 FROM wallet_folders f WHERE f.owner_id=w.owner_id AND f.chain='Solana' AND f.archived=0 AND f.id=COALESCE(json_extract(ref.value,'$.folderId'),w.folder_id) AND f.revision=json_extract(ref.value,'$.folderRevision') AND EXISTS(SELECT 1 FROM json_each(COALESCE(w.folder_ids,json_array(w.folder_id))) WHERE value=f.id)))))
 THEN RAISE(ABORT,'Runtime holder ownership changed') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pump_launch_reviews r JOIN launch_metadata_releases m ON m.owner_id=r.owner_id AND m.project_id=r.project_id AND m.id=json_extract(r.terms,'$.releaseId') WHERE r.id=NEW.review_id AND r.owner_id=NEW.owner_id) THEN RAISE(ABORT,'Runtime metadata release changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_group_signing_auth_no_update BEFORE UPDATE ON pump_group_signing_authorizations BEGIN SELECT RAISE(ABORT,'Immutable signing authorization'); END;
--> statement-breakpoint
CREATE TRIGGER pump_group_signing_auth_no_delete BEFORE DELETE ON pump_group_signing_authorizations BEGIN SELECT RAISE(ABORT,'Signing authorization history retained'); END;
