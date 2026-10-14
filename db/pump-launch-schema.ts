import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const pumpLaunchReviews = sqliteTable(
  'pump_launch_reviews',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    payer: text('payer').notNull(),
    mint: text('mint').notNull(),
    projectDocument: text('project_document').notNull(),
    terms: text('terms').notNull(),
    review: text('review').notNull(),
    simulation: text('simulation').notNull(),
    state: text('state').notNull(),
    signed: text('signed'),
    signature: text('signature'),
    receipt: text('receipt'),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => [index('pump_launch_owner_project').on(t.ownerId, t.projectId)],
);
