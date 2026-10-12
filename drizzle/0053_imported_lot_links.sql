CREATE TABLE imported_trade_lot_gates (
 owner_id TEXT NOT NULL, project_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0 AND revision<=1000000000), write_token TEXT,
 PRIMARY KEY(owner_id,project_id)
);
--> statement-breakpoint
CREATE TABLE imported_trade_lot_links (
 id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, project_id TEXT NOT NULL,
 buy_receipt_id TEXT NOT NULL, sell_receipt_id TEXT NOT NULL,
 units_raw TEXT NOT NULL CHECK(length(units_raw) BETWEEN 1 AND 20 AND units_raw GLOB '[1-9]*' AND units_raw NOT GLOB '*[^0-9]*' AND (length(units_raw)<20 OR units_raw<='18446744073709551615')),
 buy_signature TEXT NOT NULL, sell_signature TEXT NOT NULL,
 buy_preparation_sha256 TEXT NOT NULL, sell_preparation_sha256 TEXT NOT NULL, created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX imported_trade_lot_links_sell ON imported_trade_lot_links(owner_id,sell_receipt_id);
--> statement-breakpoint
CREATE INDEX imported_trade_lot_links_project ON imported_trade_lot_links(owner_id,project_id);
--> statement-breakpoint
CREATE TRIGGER imported_trade_lot_links_context BEFORE INSERT ON imported_trade_lot_links WHEN NOT EXISTS(
 SELECT 1 FROM imported_swap_receipts b JOIN imported_swap_receipts s ON s.owner_id=b.owner_id AND s.project_id=b.project_id
 WHERE b.owner_id=NEW.owner_id AND b.project_id=NEW.project_id AND b.id=NEW.buy_receipt_id AND s.id=NEW.sell_receipt_id
 AND json_extract(b.document,'$.side')='Buy' AND json_extract(s.document,'$.side')='Sell'
 AND json_extract(b.document,'$.signatureVerified')=1 AND json_extract(s.document,'$.signatureVerified')=1
 AND json_extract(b.document,'$.network')='mainnet' AND json_extract(s.document,'$.network')='mainnet'
 AND json_extract(b.document,'$.commitment')='finalized' AND json_extract(s.document,'$.commitment')='finalized'
 AND json_extract(b.document,'$.wallet')=json_extract(s.document,'$.wallet')
 AND json_extract(b.document,'$.mint')=json_extract(s.document,'$.mint')
 AND json_extract(b.document,'$.decimals')=json_extract(s.document,'$.decimals')
 AND json_extract(b.document,'$.slot')<json_extract(s.document,'$.slot')
 AND json_extract(s.document,'$.tokenUnitsRaw')=NEW.units_raw
 AND json_extract(b.document,'$.signature')=NEW.buy_signature AND json_extract(s.document,'$.signature')=NEW.sell_signature
 AND json_extract(b.document,'$.preparationSha256')=NEW.buy_preparation_sha256 AND json_extract(s.document,'$.preparationSha256')=NEW.sell_preparation_sha256
) BEGIN SELECT RAISE(ABORT,'Acquisition link context differs'); END;
--> statement-breakpoint
CREATE TRIGGER imported_trade_lot_links_immutable_update BEFORE UPDATE ON imported_trade_lot_links BEGIN SELECT RAISE(ABORT,'Acquisition link is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER imported_trade_lot_links_immutable_delete BEFORE DELETE ON imported_trade_lot_links BEGIN SELECT RAISE(ABORT,'Acquisition link is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER imported_linked_receipt_immutable_update BEFORE UPDATE ON imported_swap_receipts WHEN EXISTS(SELECT 1 FROM imported_trade_lot_links WHERE owner_id=OLD.owner_id AND (buy_receipt_id=OLD.id OR sell_receipt_id=OLD.id)) BEGIN SELECT RAISE(ABORT,'Linked receipt evidence is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER imported_linked_receipt_immutable_delete BEFORE DELETE ON imported_swap_receipts WHEN EXISTS(SELECT 1 FROM imported_trade_lot_links WHERE owner_id=OLD.owner_id AND (buy_receipt_id=OLD.id OR sell_receipt_id=OLD.id)) BEGIN SELECT RAISE(ABORT,'Linked receipt evidence is immutable'); END;
