import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
} from 'drizzle-orm/sqlite-core';
export const counterTradePlans = sqliteTable(
  'counter_trade_plans',
  {
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    id: text('id').notNull(),
    revision: integer('revision').notNull(),
    state: text('state').notNull(),
    document: text('document').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.projectId, t.id] }),
    index('counter_trade_plans_scope').on(t.ownerId, t.projectId),
  ],
);
