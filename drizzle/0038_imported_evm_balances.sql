CREATE TABLE imported_evm_balances (
 owner_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 wallet_address TEXT NOT NULL,
 document TEXT NOT NULL,
 observed_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,project_id,wallet_address)
);
