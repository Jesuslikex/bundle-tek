CREATE TABLE imported_pool_trades (
 owner_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 document TEXT NOT NULL,
 observed_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,project_id)
);
