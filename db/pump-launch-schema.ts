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
export const pumpGroupSignatures = sqliteTable(
  'pump_group_signatures',
  {
    reviewId: text('review_id')
      .primaryKey()
      .notNull()
      .references(() => pumpLaunchReviews.id),
    ownerId: text('owner_id').notNull(),
    contextSha256: text('context_sha256').notNull(),
    manifestSha256: text('manifest_sha256').notNull(),
    signedGroupSha256: text('signed_group_sha256').notNull(),
    signature: text('signature').notNull(),
    signed: text('signed').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('pump_group_signature_owner').on(t.ownerId, t.reviewId)],
);
export const pumpGroupObservations = sqliteTable(
  'pump_group_observations',
  {
    id: text('id').primaryKey().notNull(),
    ownerId: text('owner_id').notNull(),
    reviewId: text('review_id')
      .notNull()
      .references(() => pumpLaunchReviews.id),
    contextSha256: text('context_sha256').notNull(),
    manifestSha256: text('manifest_sha256').notNull(),
    signedGroupSha256: text('signed_group_sha256'),
    sourceState: text('source_state').notNull(),
    observedState: text('observed_state').notNull(),
    sha256: text('sha256').notNull(),
    observation: text('observation').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('pump_group_observation_owner').on(
      t.ownerId,
      t.reviewId,
      t.createdAt,
      t.id,
    ),
  ],
);
export const pumpGroupTerminalRecoveries = sqliteTable(
  'pump_group_terminal_recoveries',
  {
    reviewId: text('review_id')
      .primaryKey()
      .notNull()
      .references(() => pumpLaunchReviews.id),
    ownerId: text('owner_id').notNull(),
    observationId: text('observation_id')
      .notNull()
      .unique()
      .references(() => pumpGroupObservations.id),
    receipt: text('receipt').notNull(),
    createdAt: text('created_at').notNull(),
  },
);
export const pumpGroupRuntimeReviews = sqliteTable(
  'pump_group_runtime_reviews',
  {
    id: text('id').primaryKey().notNull(),
    ownerId: text('owner_id').notNull(),
    reviewId: text('review_id')
      .notNull()
      .references(() => pumpLaunchReviews.id),
    contextSha256: text('context_sha256').notNull(),
    identitySha256: text('identity_sha256').notNull(),
    preview: text('preview').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => [index('pump_group_runtime_owner').on(t.ownerId, t.reviewId, t.id)],
);
export const pumpGroupSigningAuthorizations = sqliteTable(
  'pump_group_signing_authorizations',
  {
    id: text('id').primaryKey().notNull(),
    ownerId: text('owner_id').notNull(),
    reviewId: text('review_id')
      .notNull()
      .references(() => pumpLaunchReviews.id),
    previewId: text('preview_id')
      .notNull()
      .references(() => pumpGroupRuntimeReviews.id),
    contextSha256: text('context_sha256').notNull(),
    identitySha256: text('identity_sha256').notNull(),
    consent: text('consent').notNull(),
    codeConsent: text('code_consent').notNull(),
    authorization: text('authorization').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => [
    index('pump_group_signing_auth_owner').on(t.ownerId, t.reviewId, t.id),
  ],
);
