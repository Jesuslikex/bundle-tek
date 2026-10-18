import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const strategyReviewCapacity = sqliteTable(
  'strategy_review_capacity',
  {
    draftId: text('draft_id').primaryKey().notNull(),
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    planSha256: text('plan_sha256').notNull(),
    revision: integer('revision').notNull(),
    document: text('document').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('strategy_review_capacity_owner').on(
      t.ownerId,
      t.projectId,
      t.draftId,
    ),
  ],
);
