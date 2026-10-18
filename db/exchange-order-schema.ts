import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
export const exchangeOrderReviews = sqliteTable(
  'exchange_funding_order_reviews',
  {
    id: text('id').primaryKey().notNull(),
    ownerId: text('owner_id').notNull(),
    quoteId: text('quote_id').notNull().unique(),
    planId: text('plan_id').notNull(),
    refundAddress: text('refund_address').notNull(),
    refundRevision: integer('refund_revision').notNull(),
    document: text('document').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => [index('idx_exchange_order_reviews_owner').on(t.ownerId, t.createdAt)],
);
export const exchangeOrderApprovals = sqliteTable(
  'exchange_funding_order_approvals',
  {
    reviewId: text('review_id')
      .primaryKey()
      .notNull()
      .references(() => exchangeOrderReviews.id),
    ownerId: text('owner_id').notNull(),
    sha256: text('sha256').notNull(),
    consent: text('consent').notNull(),
    createdAt: text('created_at').notNull(),
  },
);
export const exchangeOrderAttempts = sqliteTable(
  'exchange_funding_order_attempts',
  {
    reviewId: text('review_id')
      .primaryKey()
      .notNull()
      .references(() => exchangeOrderReviews.id),
    ownerId: text('owner_id').notNull(),
    planId: text('plan_id').notNull(),
    id: text('id').notNull().unique(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_exchange_order_one_attempt_per_draft').on(
      t.ownerId,
      t.planId,
    ),
  ],
);
export const exchangeOrderReferences = sqliteTable(
  'exchange_funding_order_references',
  {
    reviewId: text('review_id')
      .primaryKey()
      .notNull()
      .references(() => exchangeOrderAttempts.reviewId),
    ownerId: text('owner_id').notNull(),
    providerId: text('provider_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
);
export const exchangeOrderResults = sqliteTable(
  'exchange_funding_order_results',
  {
    reviewId: text('review_id')
      .primaryKey()
      .notNull()
      .references(() => exchangeOrderAttempts.reviewId),
    ownerId: text('owner_id').notNull(),
    outcome: text('outcome').notNull(),
    document: text('document').notNull(),
    createdAt: text('created_at').notNull(),
  },
);
export const exchangeOrderObservations = sqliteTable(
  'exchange_funding_order_observations',
  {
    id: text('id').primaryKey().notNull(),
    reviewId: text('review_id')
      .notNull()
      .references(() => exchangeOrderAttempts.reviewId),
    ownerId: text('owner_id').notNull(),
    document: text('document').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('idx_exchange_order_observations_owner').on(
      t.ownerId,
      t.reviewId,
      t.createdAt,
    ),
  ],
);
