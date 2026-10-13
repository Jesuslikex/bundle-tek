CREATE TABLE `jito_bundle_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`owner_id` text NOT NULL,
	`bundle_id` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`type` text NOT NULL,
	`packet` integer,
	`document` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jito_bundle_event_identity` ON `jito_bundle_events` (`owner_id`,`id`);--> statement-breakpoint
CREATE INDEX `jito_bundle_events_owner` ON `jito_bundle_events` (`owner_id`,`created_at`,`sequence`);--> statement-breakpoint
CREATE INDEX `jito_bundle_events_bundle` ON `jito_bundle_events` (`owner_id`,`bundle_id`,`created_at`,`sequence`);
--> statement-breakpoint
CREATE VIEW jito_bundle_activity_projection AS
SELECT b.owner_id,b.id,b.project_id,b.session_id,
 json_object('format','jito-bundle-activity-v1','id',b.id,'projectId',b.project_id,'sessionId',b.session_id,
 'sessionRevision',json_extract(b.document,'$.sessionRevision'),'sha256',json_extract(b.document,'$.sha256'),
 'state',b.state,'bundleId',b.bundle_id,'swapCount',json_array_length(b.document,'$.swaps'),
 'packetCount',json_array_length(b.document,'$.swaps')+1,
 'signedCount',(SELECT count(*) FROM jito_bundle_packets p WHERE p.owner_id=b.owner_id AND p.bundle_id=b.id AND p.signature IS NOT NULL),
 'tipLamports',json_extract(b.document,'$.tip.amountRaw'),'createdAt',b.created_at,'updatedAt',b.updated_at) AS document
FROM jito_bundles b;
--> statement-breakpoint
CREATE TRIGGER jito_bundle_review_event AFTER INSERT ON jito_bundles BEGIN
 INSERT INTO jito_bundle_events(id,owner_id,bundle_id,project_id,session_id,type,packet,document,created_at)
 SELECT lower(hex(randomblob(16))),owner_id,id,project_id,session_id,'bundle.reviewed',NULL,document,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM jito_bundle_activity_projection WHERE owner_id=NEW.owner_id AND id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER jito_bundle_state_event AFTER UPDATE OF state,bundle_id ON jito_bundles WHEN NEW.state<>OLD.state OR NEW.bundle_id IS NOT OLD.bundle_id BEGIN
 INSERT INTO jito_bundle_events(id,owner_id,bundle_id,project_id,session_id,type,packet,document,created_at)
 SELECT lower(hex(randomblob(16))),owner_id,id,project_id,session_id,'bundle.'||NEW.state,NULL,document,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM jito_bundle_activity_projection WHERE owner_id=NEW.owner_id AND id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER jito_bundle_packet_event AFTER UPDATE OF signature ON jito_bundle_packets WHEN OLD.signature IS NULL AND NEW.signature IS NOT NULL BEGIN
 INSERT INTO jito_bundle_events(id,owner_id,bundle_id,project_id,session_id,type,packet,document,created_at)
 SELECT lower(hex(randomblob(16))),owner_id,id,project_id,session_id,'packet.registered',NEW.packet,document,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM jito_bundle_activity_projection WHERE owner_id=NEW.owner_id AND id=NEW.bundle_id;
END;
--> statement-breakpoint
CREATE TRIGGER jito_bundle_event_immutable BEFORE UPDATE ON jito_bundle_events BEGIN
 SELECT RAISE(ABORT,'Bundle events are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER jito_bundle_event_retained BEFORE DELETE ON jito_bundle_events BEGIN
 SELECT RAISE(ABORT,'Bundle events are retained');
END;
