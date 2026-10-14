import { blob, index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const launchMetadataReleases = sqliteTable(
  'launch_metadata_releases',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    sourceDocument: text('source_document').notNull(),
    metadata: text('metadata').notNull(),
    image: blob('image', { mode: 'buffer' }).notNull(),
    mime: text('mime').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('launch_metadata_owner').on(t.ownerId, t.projectId)],
);
