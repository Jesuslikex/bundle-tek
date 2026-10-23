CREATE TABLE launchlab_launch_recoveries (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL,
 venue TEXT NOT NULL CHECK(venue IN ('launchlab')),
 project_id TEXT NOT NULL,
 payer TEXT NOT NULL,
 mint TEXT NOT NULL,
 project_document TEXT NOT NULL CHECK(json_valid(project_document)),
 terms TEXT NOT NULL CHECK(json_valid(terms)),
 review TEXT NOT NULL CHECK(json_valid(review)),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
 minimum_slot INTEGER NOT NULL CHECK(minimum_slot>=0),
 state TEXT NOT NULL CHECK(state IN ('review','approved','signed','submitting','submitted','finalized','failed','cancelled')),
 signed TEXT,
 signature TEXT,
 receipt TEXT CHECK(receipt IS NULL OR json_valid(receipt)),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 expires_at TEXT NOT NULL,
 CHECK(json_extract(terms,'$.projectId')=project_id AND json_extract(terms,'$.payer')=payer AND json_extract(terms,'$.mint')=mint),
 CHECK(json_extract(review,'$.sha256')=sha256 AND json_extract(review,'$.expiresAt')=expires_at),
 CHECK((signed IS NULL AND signature IS NULL) OR (length(signed) BETWEEN 1 AND 1800 AND length(signature) BETWEEN 64 AND 88)),
 CHECK(state NOT IN ('signed','submitting','submitted','finalized','failed') OR signed IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX launchlab_launch_recoveries_active_project ON launchlab_launch_recoveries(owner_id,project_id) WHERE state NOT IN ('finalized','failed','cancelled');
--> statement-breakpoint
CREATE UNIQUE INDEX launchlab_launch_recoveries_active_payer ON launchlab_launch_recoveries(owner_id,payer) WHERE state NOT IN ('finalized','failed','cancelled');
--> statement-breakpoint
CREATE UNIQUE INDEX launchlab_launch_recoveries_active_mint ON launchlab_launch_recoveries(mint) WHERE state NOT IN ('finalized','failed','cancelled');
--> statement-breakpoint
CREATE INDEX launchlab_launch_recoveries_history ON launchlab_launch_recoveries(owner_id,venue,project_id,created_at DESC,id DESC);
--> statement-breakpoint
CREATE TRIGGER launchlab_launch_recoveries_admission BEFORE INSERT ON launchlab_launch_recoveries
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM launchlab_launch_recoveries v WHERE v.id=NEW.id) OR NEW.state!='review' OR NEW.signed IS NOT NULL OR NEW.signature IS NOT NULL OR NEW.receipt IS NOT NULL
 OR EXISTS(SELECT 1 FROM launchlab_launch_recoveries v WHERE v.state NOT IN ('cancelled','failed','finalized') AND ((v.owner_id=NEW.owner_id AND (v.project_id=NEW.project_id OR v.payer=NEW.payer)) OR v.mint=NEW.mint))
 OR json_type(NEW.terms,'$.venue') IS NOT 'text' OR json_extract(NEW.terms,'$.venue') NOT IN ('LetsBonk','Surge') OR json_extract(NEW.review,'$.input.venue') IS NOT json_extract(NEW.terms,'$.venue') OR json_extract(NEW.review,'$.summary.venue') IS NOT json_extract(NEW.terms,'$.venue') OR json_extract(NEW.project_document,'$.plan.launchpad') IS NOT json_extract(NEW.terms,'$.venue') OR json_extract(NEW.project_document,'$.plan.chain') IS NOT 'Solana'
 OR EXISTS(SELECT 1 FROM venue_launch_recoveries v WHERE v.state NOT IN ('cancelled','failed','finalized') AND ((v.owner_id=NEW.owner_id AND (v.project_id=NEW.project_id OR v.payer=NEW.payer)) OR v.mint=NEW.mint))
 OR EXISTS(SELECT 1 FROM json_each(NEW.terms) t WHERE t.key!='origin' AND (json_type(NEW.review,'$.terms.'||t.key) IS NOT t.type OR json_extract(NEW.review,'$.terms.'||t.key) IS NOT t.value))
 OR (SELECT count(*) FROM json_each(NEW.terms) WHERE key!='origin')!=(SELECT count(*) FROM json_each(NEW.review,'$.terms'))
 OR NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now') OR NEW.expires_at<=NEW.created_at
 OR json_extract(NEW.review,'$.format') IS NOT 'launchlab-launch-review-v1'
 OR NOT EXISTS(SELECT 1 FROM workspace_projects p JOIN workspace_wallets w ON w.owner_id=p.owner_id AND w.address=NEW.payer AND w.chain='Solana' WHERE p.owner_id=NEW.owner_id AND p.id=NEW.project_id AND p.archived=0 AND p.document=NEW.project_document AND p.updated_at=json_extract(NEW.terms,'$.updatedAt') AND w.archived=0 AND w.revision=json_extract(NEW.terms,'$.payerRevision'))
 OR EXISTS(SELECT 1 FROM pump_launch_reviews p WHERE ((p.state NOT IN ('cancelled','failed','finalized') AND p.owner_id=NEW.owner_id AND (p.payer=NEW.payer OR p.project_id=NEW.project_id)) OR (p.state NOT IN ('cancelled','failed') AND p.mint=NEW.mint)))
 THEN RAISE(ABORT,'Venue launch source is unavailable or busy') END;
END;
--> statement-breakpoint
CREATE TRIGGER launchlab_launch_recoveries_immutable BEFORE UPDATE ON launchlab_launch_recoveries
BEGIN
 SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.venue IS NOT OLD.venue OR NEW.project_id IS NOT OLD.project_id OR NEW.payer IS NOT OLD.payer OR NEW.mint IS NOT OLD.mint OR NEW.project_document IS NOT OLD.project_document OR NEW.terms IS NOT OLD.terms OR NEW.review IS NOT OLD.review OR NEW.sha256 IS NOT OLD.sha256 OR NEW.minimum_slot IS NOT OLD.minimum_slot OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
 OR (OLD.signed IS NOT NULL AND (NEW.signed IS NOT OLD.signed OR NEW.signature IS NOT OLD.signature))
 OR (OLD.receipt IS NOT NULL AND NEW.receipt IS NOT OLD.receipt)
 THEN RAISE(ABORT,'Saved venue launch is immutable') END;
 SELECT CASE WHEN NOT (
 (OLD.state='review' AND NEW.state IN ('approved','cancelled')) OR
 (OLD.state='approved' AND NEW.state IN ('signed','cancelled')) OR
 (OLD.state='signed' AND NEW.state IN ('submitting','finalized','failed','cancelled')) OR
 (OLD.state='submitting' AND NEW.state IN ('submitted','finalized','failed','cancelled')) OR
 (OLD.state='submitted' AND NEW.state IN ('finalized','failed','cancelled')))
 THEN RAISE(ABORT,'Invalid venue launch transition') END;
 SELECT CASE WHEN (NEW.signed IS NOT OLD.signed OR NEW.signature IS NOT OLD.signature) AND NOT (OLD.state='approved' AND NEW.state='signed' AND OLD.signed IS NULL AND NEW.signed IS NOT NULL)
 THEN RAISE(ABORT,'Signatures require original approval') END;
 SELECT CASE WHEN NEW.receipt IS NOT OLD.receipt AND NEW.state NOT IN ('finalized','failed','cancelled') THEN RAISE(ABORT,'Receipt requires terminal recovery') END;
 SELECT CASE WHEN NEW.state IN ('approved','submitting') AND (
 NEW.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') OR
 NOT EXISTS(SELECT 1 FROM workspace_projects p JOIN workspace_wallets w ON w.owner_id=p.owner_id AND w.address=NEW.payer AND w.chain='Solana' WHERE p.owner_id=NEW.owner_id AND p.id=NEW.project_id AND p.archived=0 AND p.document=NEW.project_document AND p.updated_at=json_extract(NEW.terms,'$.updatedAt') AND w.archived=0 AND w.revision=json_extract(NEW.terms,'$.payerRevision')) OR
 NOT EXISTS(SELECT 1 FROM wallet_ownership_proofs o WHERE o.owner_id=NEW.owner_id AND o.chain='Solana' AND o.address=NEW.payer))
 THEN RAISE(ABORT,'Venue launch source or lifetime changed') END;
 SELECT CASE WHEN NEW.state IN ('finalized','failed') AND (json_extract(NEW.receipt,'$.kind') IS NOT 'finalized' OR json_extract(NEW.receipt,'$.signature') IS NOT NEW.signature OR json_extract(NEW.receipt,'$.mint') IS NOT NEW.mint OR json_extract(NEW.receipt,'$.commitment') IS NOT 'finalized' OR json_extract(NEW.receipt,'$.network') IS NOT 'mainnet' OR json_extract(NEW.receipt,'$.succeeded') IS NOT (NEW.state='finalized'))
 THEN RAISE(ABORT,'Finalized venue receipt required') END;
 SELECT CASE WHEN NEW.state='cancelled' AND OLD.state!='review' AND (json_extract(NEW.receipt,'$.kind') IS NOT 'expired-unobserved' OR json_extract(NEW.receipt,'$.mintAbsent') IS NOT 1 OR json_extract(NEW.receipt,'$.mint') IS NOT NEW.mint OR json_extract(NEW.receipt,'$.signature') IS NOT NEW.signature OR json_extract(NEW.receipt,'$.lastValidBlockHeight') IS NOT json_extract(NEW.review,'$.input.lastValidBlockHeight') OR json_extract(NEW.receipt,'$.network') IS NOT 'mainnet' OR json_extract(NEW.receipt,'$.commitment') IS NOT 'finalized')
 THEN RAISE(ABORT,'Original expiry evidence required') END;
END;
--> statement-breakpoint
CREATE TRIGGER launchlab_launch_recoveries_no_delete BEFORE DELETE ON launchlab_launch_recoveries BEGIN SELECT RAISE(ABORT,'Saved venue launch cannot be deleted'); END;
--> statement-breakpoint
CREATE TRIGGER pump_launch_launchlab_recovery_exclusion BEFORE INSERT ON pump_launch_reviews
WHEN NEW.state NOT IN ('cancelled','failed','finalized')
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM launchlab_launch_recoveries v WHERE ((v.state NOT IN ('cancelled','failed','finalized') AND v.owner_id=NEW.owner_id AND (v.payer=NEW.payer OR v.project_id=NEW.project_id)) OR (v.state NOT IN ('cancelled','failed') AND v.mint=NEW.mint))) THEN RAISE(ABORT,'Payer has an unresolved venue launch') END;
END;

--> statement-breakpoint
CREATE TRIGGER launchlab_other_venue_recovery_exclusion BEFORE INSERT ON venue_launch_recoveries
WHEN NEW.state NOT IN ('cancelled','failed','finalized')
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM launchlab_launch_recoveries v WHERE v.state NOT IN ('cancelled','failed','finalized') AND ((v.owner_id=NEW.owner_id AND (v.project_id=NEW.project_id OR v.payer=NEW.payer)) OR v.mint=NEW.mint)) THEN RAISE(ABORT,'LaunchLab launch requires recovery') END;
END;

--> statement-breakpoint
CREATE TRIGGER venue_pump_recovery_identity_exclusion BEFORE INSERT ON venue_launch_recoveries
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pump_launch_reviews p WHERE ((p.state NOT IN ('cancelled','failed','finalized') AND p.owner_id=NEW.owner_id AND (p.payer=NEW.payer OR p.project_id=NEW.project_id)) OR (p.state NOT IN ('cancelled','failed') AND p.mint=NEW.mint))) THEN RAISE(ABORT,'Pump launch identity requires recovery') END;
END;
--> statement-breakpoint
CREATE TRIGGER pump_other_venue_recovery_identity_exclusion BEFORE INSERT ON pump_launch_reviews
WHEN NEW.state NOT IN ('cancelled','failed','finalized')
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM venue_launch_recoveries v WHERE ((v.state NOT IN ('cancelled','failed','finalized') AND v.owner_id=NEW.owner_id AND (v.payer=NEW.payer OR v.project_id=NEW.project_id)) OR (v.state NOT IN ('cancelled','failed') AND v.mint=NEW.mint))) THEN RAISE(ABORT,'Venue launch identity requires recovery') END;
END;
