CREATE TABLE sniper_nuke_sells(id TEXT PRIMARY KEY NOT NULL,owner_id TEXT NOT NULL,guard_id TEXT NOT NULL REFERENCES sniper_guards(id),batch_id TEXT NOT NULL,wallet TEXT NOT NULL,review TEXT NOT NULL CHECK(json_valid(review) AND length(review)<=16384),review_sha256 TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('review','signed','submitting','submitted','finalized','failed','expired','cancelled')),signed TEXT,signature TEXT UNIQUE,receipt TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 CHECK((state IN ('review','cancelled','expired') AND signed IS NULL AND signature IS NULL) OR (state NOT IN ('review','cancelled') AND signed IS NOT NULL AND signature IS NOT NULL)));
--> statement-breakpoint
CREATE INDEX sniper_nuke_sells_batch ON sniper_nuke_sells(owner_id,batch_id,created_at,id);
--> statement-breakpoint
CREATE UNIQUE INDEX sniper_nuke_sells_open_wallet ON sniper_nuke_sells(owner_id,wallet) WHERE state IN ('review','signed','submitting','submitted');
--> statement-breakpoint
CREATE TRIGGER sniper_nuke_sell_insert BEFORE INSERT ON sniper_nuke_sells BEGIN
 SELECT RAISE(ABORT,'Nuke sell must start unsigned from a triggered guard') WHERE NEW.state IS NOT 'review' OR NEW.signed IS NOT NULL OR NEW.signature IS NOT NULL OR NEW.receipt IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM sniper_guards g WHERE g.id=NEW.guard_id AND g.owner_id=NEW.owner_id AND g.state='triggered');
END;
--> statement-breakpoint
CREATE TRIGGER sniper_nuke_sell_identity BEFORE UPDATE ON sniper_nuke_sells WHEN NEW.id IS NOT OLD.id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.guard_id IS NOT OLD.guard_id OR NEW.batch_id IS NOT OLD.batch_id OR NEW.wallet IS NOT OLD.wallet OR NEW.review IS NOT OLD.review OR NEW.review_sha256 IS NOT OLD.review_sha256 OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.signed IS NOT NULL AND NEW.signed IS NOT OLD.signed) OR (OLD.signature IS NOT NULL AND NEW.signature IS NOT OLD.signature) OR (OLD.receipt IS NOT NULL AND NEW.receipt IS NOT OLD.receipt) BEGIN
 SELECT RAISE(ABORT,'Nuke sell evidence is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER sniper_nuke_sell_transition BEFORE UPDATE OF state ON sniper_nuke_sells WHEN OLD.state IS NOT NEW.state AND NOT (
 (OLD.state='review' AND NEW.state IN ('signed','cancelled','expired'))
 OR (OLD.state='signed' AND NEW.state IN ('submitting','expired'))
 OR (OLD.state='submitting' AND NEW.state IN ('submitted','finalized','failed','expired'))
 OR (OLD.state='submitted' AND NEW.state IN ('finalized','failed','expired'))) BEGIN
 SELECT RAISE(ABORT,'Nuke sell state transition is not allowed');
END;
--> statement-breakpoint
CREATE TRIGGER sniper_nuke_sell_delete BEFORE DELETE ON sniper_nuke_sells BEGIN SELECT RAISE(ABORT,'Nuke sell history is retained'); END;
