CREATE TABLE strategy_review_capacity (
 draft_id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256)=64),
 revision INTEGER NOT NULL CHECK(revision>0),
 document TEXT NOT NULL CHECK(length(document)<=524288 AND json_valid(document)
  AND json_extract(document,'$.format') IS 'strategy-review-capacity-v1'
  AND json_type(document,'$.holds') IS 'array' AND json_array_length(document,'$.holds')<=1000
  AND json_type(document,'$.planningOnly') IS 'true'
  AND json_type(document,'$.fundingAllowed') IS 'false'
  AND json_type(document,'$.signingAllowed') IS 'false'
  AND json_type(document,'$.executionAllowed') IS 'false'),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX strategy_review_capacity_owner ON strategy_review_capacity(owner_id,project_id,draft_id);
--> statement-breakpoint
CREATE TRIGGER strategy_review_capacity_immutable BEFORE UPDATE ON strategy_review_capacity BEGIN
 SELECT CASE WHEN NEW.draft_id<>OLD.draft_id OR NEW.owner_id<>OLD.owner_id OR NEW.project_id<>OLD.project_id
 OR NEW.plan_sha256<>OLD.plan_sha256 OR NEW.created_at<>OLD.created_at OR NEW.revision<>OLD.revision+1
 OR NEW.updated_at<OLD.updated_at OR NEW.document=OLD.document
 THEN RAISE(ABORT,'Review capacity identity or revision differs') END;
 SELECT CASE WHEN NOT (
  (json_array_length(NEW.document,'$.holds')=json_array_length(OLD.document,'$.holds')+1
   AND NOT EXISTS(SELECT 1 FROM json_each(OLD.document,'$.holds') o WHERE o.value IS NOT json_extract(NEW.document,'$.holds['||o.key||']'))
   AND json_extract(NEW.document,'$.holds[#-1].state') IS 'held'
   AND json_type(NEW.document,'$.holds[#-1].releasedAt') IS 'null')
  OR (json_array_length(NEW.document,'$.holds')=json_array_length(OLD.document,'$.holds')
   AND (SELECT count(*) FROM json_each(OLD.document,'$.holds') o JOIN json_each(NEW.document,'$.holds') n ON n.key=o.key WHERE n.value<>o.value)=1
   AND NOT EXISTS(SELECT 1 FROM json_each(OLD.document,'$.holds') o JOIN json_each(NEW.document,'$.holds') n ON n.key=o.key WHERE n.value<>o.value AND NOT (
    json_extract(o.value,'$.state') IS 'held' AND json_extract(n.value,'$.state') IS 'released'
    AND json_type(n.value,'$.releasedAt') IS 'text'
    AND json_remove(o.value,'$.state','$.releasedAt') IS json_remove(n.value,'$.state','$.releasedAt')
   )))
 ) THEN RAISE(ABORT,'Review holds must be retained and only unsigned holds can release') END;
END;
--> statement-breakpoint
CREATE TRIGGER strategy_review_capacity_retained BEFORE DELETE ON strategy_review_capacity BEGIN
 SELECT RAISE(ABORT,'Review capacity history is retained');
END;
