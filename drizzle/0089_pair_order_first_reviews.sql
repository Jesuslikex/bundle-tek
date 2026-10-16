CREATE TABLE pair_order_first_reviews (
 id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL,
 project_id TEXT NOT NULL, project_revision INTEGER NOT NULL CHECK(project_revision>0),
 wallet TEXT NOT NULL, wallet_revision INTEGER NOT NULL CHECK(wallet_revision>0),
 document TEXT NOT NULL CHECK(json_valid(document)), sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 CHECK(julianday(expires_at)>julianday(created_at)),
 CHECK(json_extract(document,'$.review.signingAllowed')=0),
 CHECK(json_extract(document,'$.review.executionAllowed')=0)
);
--> statement-breakpoint
CREATE INDEX pair_order_first_owner ON pair_order_first_reviews(owner_id,project_id,created_at);
--> statement-breakpoint
CREATE TRIGGER pair_order_first_owned BEFORE INSERT ON pair_order_first_reviews BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM imported_token_projects p JOIN workspace_wallets w ON w.owner_id=p.owner_id WHERE p.id=NEW.project_id AND p.owner_id=NEW.owner_id AND p.chain='Solana' AND p.archived=0 AND p.revision=NEW.project_revision AND w.chain='Solana' AND w.address=NEW.wallet AND w.revision=NEW.wallet_revision AND w.archived=0 AND w.role IN ('Recipient','Deployer','Funder')) THEN RAISE(ABORT,'Pair review ownership changed') END;
 SELECT CASE WHEN json_extract(NEW.document,'$.review.projectId') IS NOT NEW.project_id OR json_extract(NEW.document,'$.review.projectRevision') IS NOT NEW.project_revision OR json_extract(NEW.document,'$.review.wallet') IS NOT NEW.wallet OR json_extract(NEW.document,'$.review.createdAt') IS NOT NEW.created_at OR json_extract(NEW.document,'$.review.expiresAt') IS NOT NEW.expires_at OR json_extract(NEW.document,'$.request.walletRevision') IS NOT NEW.wallet_revision THEN RAISE(ABORT,'Pair review binding differs') END;
END;
--> statement-breakpoint
CREATE TRIGGER pair_order_first_no_update BEFORE UPDATE ON pair_order_first_reviews BEGIN SELECT RAISE(ABORT,'Immutable pair review'); END;
--> statement-breakpoint
CREATE TRIGGER pair_order_first_no_delete BEFORE DELETE ON pair_order_first_reviews BEGIN SELECT RAISE(ABORT,'Immutable pair review'); END;
