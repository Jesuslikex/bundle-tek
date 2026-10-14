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
export const pumpGroupApprovals = sqliteTable(
  'pump_group_approvals',
  {
    reviewId: text('review_id')
      .primaryKey()
      .notNull()
      .references(() => pumpLaunchReviews.id),
    ownerId: text('owner_id').notNull(),
    contextSha256: text('context_sha256').notNull(),
    manifestSha256: text('manifest_sha256').notNull(),
    simulationSha256: text('simulation_sha256').notNull(),
    freshSimulationSha256: text('fresh_simulation_sha256').notNull(),
    consent: text('consent').notNull(),
    fresh: text('fresh').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('pump_group_approval_owner').on(t.ownerId, t.reviewId)],
);
