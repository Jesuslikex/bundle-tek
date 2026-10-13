CREATE TABLE `conditional_order_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`owner_id` text NOT NULL,
	`project_id` text NOT NULL,
	`order_id` text NOT NULL,
	`type` text NOT NULL,
	`document` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conditional_order_events_id_unique` ON `conditional_order_events` (`id`);--> statement-breakpoint
CREATE INDEX `conditional_order_events_scope` ON `conditional_order_events` (`owner_id`,`project_id`,`created_at`,`sequence`);
--> statement-breakpoint
CREATE TRIGGER conditional_order_event_saved AFTER INSERT ON conditional_sell_orders BEGIN
 INSERT INTO conditional_order_events(id,owner_id,project_id,order_id,type,document,created_at)
 VALUES(lower(hex(randomblob(16))),NEW.owner_id,NEW.project_id,NEW.id,'order.saved',json_object('id',NEW.id,'revision',NEW.revision,'state',NEW.state,'terms',json(NEW.document),'createdAt',NEW.created_at,'updatedAt',NEW.updated_at),NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER conditional_order_event_cancelled AFTER UPDATE OF state ON conditional_sell_orders WHEN OLD.state<>NEW.state BEGIN
 INSERT INTO conditional_order_events(id,owner_id,project_id,order_id,type,document,created_at)
 VALUES(lower(hex(randomblob(16))),NEW.owner_id,NEW.project_id,NEW.id,'order.cancelled',json_object('id',NEW.id,'revision',NEW.revision,'state',NEW.state,'terms',json(NEW.document),'createdAt',NEW.created_at,'updatedAt',NEW.updated_at),NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER conditional_order_identity BEFORE UPDATE ON conditional_sell_orders WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.project_id<>OLD.project_id OR NEW.document<>OLD.document OR NEW.created_at<>OLD.created_at OR OLD.state<>'draft' OR NEW.state<>'cancelled' OR OLD.revision<>1 OR NEW.revision<>2 OR COALESCE(julianday(NEW.updated_at)<julianday(OLD.updated_at),1) BEGIN SELECT RAISE(ABORT,'Conditional order lifecycle differs'); END;
--> statement-breakpoint
CREATE TRIGGER conditional_order_retained BEFORE DELETE ON conditional_sell_orders BEGIN SELECT RAISE(ABORT,'Conditional orders are retained'); END;
--> statement-breakpoint
CREATE TRIGGER conditional_order_event_immutable BEFORE UPDATE ON conditional_order_events BEGIN SELECT RAISE(ABORT,'Conditional order history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER conditional_order_event_retained BEFORE DELETE ON conditional_order_events BEGIN SELECT RAISE(ABORT,'Conditional order history is retained'); END;
