import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const strategySessionDrafts = sqliteTable(
  'strategy_session_drafts',
  {
    id: text('id').primaryKey().notNull(),
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    projectRevision: integer('project_revision').notNull(),
    revision: integer('revision').notNull(),
    archived: integer('archived').notNull(),
    document: text('document').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('strategy_session_drafts_owner').on(
      t.ownerId,
      t.projectId,
      t.archived,
      t.createdAt,
      t.id,
    ),
  ],
);
