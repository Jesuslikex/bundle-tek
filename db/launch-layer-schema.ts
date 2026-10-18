import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const launchLayerPlans = sqliteTable(
  'launch_layer_plans',
  {
    id: text('id').primaryKey().notNull(),
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    projectRevision: text('project_revision').notNull(),
    sourceDocument: text('source_document').notNull(),
    document: text('document').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('launch_layer_plans_owner').on(
      t.ownerId,
      t.projectId,
      t.createdAt,
      t.id,
    ),
    uniqueIndex('launch_layer_plans_exact_snapshot').on(
      t.ownerId,
      t.projectId,
      t.sha256,
    ),
  ],
);
