CREATE TABLE supply_alert_reviews (
 owner_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 scope_id TEXT NOT NULL,
 reviewed_through INTEGER NOT NULL CHECK(reviewed_through >= 0),
 updated_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,project_id,scope_id)
);
