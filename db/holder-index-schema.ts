import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
} from 'drizzle-orm/sqlite-core';

export const holderIndexRuns = sqliteTable(
  'holder_index_runs',
  {
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    id: text('id').notNull(),
    projectRevision: integer('project_revision').notNull(),
    document: text('document').notNull(),
    lastPage: integer('last_page').notNull(),
    indexedRaw: text('indexed_raw').notNull(),
    status: text('status').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.projectId, t.id] }),
    index('holder_index_runs_recent').on(t.ownerId, t.projectId, t.updatedAt),
  ],
);
export const holderIndexPages = sqliteTable(
  'holder_index_pages',
  {
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    runId: text('run_id').notNull(),
    page: integer('page').notNull(),
    document: text('document').notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.projectId, t.runId, t.page] })],
);
export const holderIndexAccounts = sqliteTable(
  'holder_index_accounts',
  {
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    runId: text('run_id').notNull(),
    address: text('address').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.projectId, t.runId, t.address] }),
  ],
);
