CREATE TABLE conditional_sell_orders (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  document TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('draft','cancelled')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,id)
);
--> statement-breakpoint
CREATE INDEX conditional_sell_orders_project ON conditional_sell_orders(owner_id,project_id,created_at,id);
