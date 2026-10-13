CREATE TABLE `jito_bundle_finalizations` (
	`owner_id` text NOT NULL,
	`bundle_id` text NOT NULL,
	`document` text NOT NULL,
	`observed_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `bundle_id`)
);
--> statement-breakpoint
CREATE TRIGGER jito_finalization_insert BEFORE INSERT ON jito_bundle_finalizations BEGIN
 SELECT CASE WHEN COALESCE((NOT json_valid(NEW.document) OR length(NEW.document)>2048 OR json_extract(NEW.document,'$.format')<>'jito-finalization-v1' OR json_type(NEW.document,'$.slot')<>'integer' OR json_extract(NEW.document,'$.slot')<1 OR length(json_extract(NEW.document,'$.sha256'))<>64 OR json_extract(NEW.document,'$.observedAt')<>NEW.observed_at OR NOT EXISTS(SELECT 1 FROM jito_bundles b WHERE b.owner_id=NEW.owner_id AND b.id=NEW.bundle_id AND b.state IN ('submitting','submitted') AND json_extract(b.document,'$.sha256')=json_extract(NEW.document,'$.bundleSha256') AND json_array_length(NEW.document,'$.signatures')=json_array_length(b.document,'$.swaps')+1 AND (SELECT count(*) FROM jito_bundle_packets p WHERE p.owner_id=b.owner_id AND p.bundle_id=b.id AND p.signature=json_extract(NEW.document,'$.signatures['||p.packet||']'))=json_array_length(NEW.document,'$.signatures'))),1) THEN RAISE(ABORT,'Finalization receipt differs') END;
END;
--> statement-breakpoint
CREATE TRIGGER jito_finalization_immutable BEFORE UPDATE ON jito_bundle_finalizations BEGIN SELECT RAISE(ABORT,'Finalization receipt is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER jito_finalization_retained BEFORE DELETE ON jito_bundle_finalizations BEGIN SELECT RAISE(ABORT,'Finalization receipt is retained'); END;
