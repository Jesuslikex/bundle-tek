DROP TRIGGER launchlab_launch_recoveries_admission;
--> statement-breakpoint
CREATE TRIGGER launchlab_launch_recoveries_admission BEFORE INSERT ON launchlab_launch_recoveries
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM launchlab_launch_recoveries v WHERE v.id=NEW.id) OR NEW.state!='review' OR NEW.signed IS NOT NULL OR NEW.signature IS NOT NULL OR NEW.receipt IS NOT NULL
 OR EXISTS(SELECT 1 FROM launchlab_launch_recoveries v WHERE v.state NOT IN ('cancelled','failed','finalized') AND ((v.owner_id=NEW.owner_id AND (v.project_id=NEW.project_id OR v.payer=NEW.payer)) OR v.mint=NEW.mint))
 OR json_type(NEW.terms,'$.venue') IS NOT 'text' OR json_extract(NEW.terms,'$.venue') NOT IN ('LetsBonk','Surge','Raydium LaunchLab') OR json_extract(NEW.review,'$.input.venue') IS NOT json_extract(NEW.terms,'$.venue') OR json_extract(NEW.review,'$.summary.venue') IS NOT json_extract(NEW.terms,'$.venue') OR json_extract(NEW.project_document,'$.plan.launchpad') IS NOT json_extract(NEW.terms,'$.venue') OR json_extract(NEW.project_document,'$.plan.chain') IS NOT 'Solana'
 OR EXISTS(SELECT 1 FROM venue_launch_recoveries v WHERE v.state NOT IN ('cancelled','failed','finalized') AND ((v.owner_id=NEW.owner_id AND (v.project_id=NEW.project_id OR v.payer=NEW.payer)) OR v.mint=NEW.mint))
 OR EXISTS(SELECT 1 FROM json_each(NEW.terms) t WHERE t.key!='origin' AND (json_type(NEW.review,'$.terms.'||t.key) IS NOT t.type OR json_extract(NEW.review,'$.terms.'||t.key) IS NOT t.value))
 OR (SELECT count(*) FROM json_each(NEW.terms) WHERE key!='origin')!=(SELECT count(*) FROM json_each(NEW.review,'$.terms'))
 OR NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now') OR NEW.expires_at<=NEW.created_at
 OR json_extract(NEW.review,'$.format') IS NOT 'launchlab-launch-review-v1'
 OR NOT EXISTS(SELECT 1 FROM workspace_projects p JOIN workspace_wallets w ON w.owner_id=p.owner_id AND w.address=NEW.payer AND w.chain='Solana' WHERE p.owner_id=NEW.owner_id AND p.id=NEW.project_id AND p.archived=0 AND p.document=NEW.project_document AND p.updated_at=json_extract(NEW.terms,'$.updatedAt') AND w.archived=0 AND w.revision=json_extract(NEW.terms,'$.payerRevision'))
 OR EXISTS(SELECT 1 FROM pump_launch_reviews p WHERE ((p.state NOT IN ('cancelled','failed','finalized') AND p.owner_id=NEW.owner_id AND (p.payer=NEW.payer OR p.project_id=NEW.project_id)) OR (p.state NOT IN ('cancelled','failed') AND p.mint=NEW.mint)))
 THEN RAISE(ABORT,'Venue launch source is unavailable or busy') END;
END;
