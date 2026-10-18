import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { pumpLaunchReviews } from './pump-launch-schema';
export const pumpGroupReceiptEvidence = sqliteTable(
  'pump_group_receipt_evidence',
  {
    id: text('id').notNull(),
    ownerId: text('owner_id').notNull(),
    reviewId: text('review_id')
      .notNull()
      .references(() => pumpLaunchReviews.id),
    contextSha256: text('context_sha256').notNull(),
    signedGroupSha256: text('signed_group_sha256').notNull(),
    sha256: text('sha256').notNull(),
    evidence: text('evidence').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.id] }),
    index('pump_group_receipt_evidence_owner').on(
      t.ownerId,
      t.reviewId,
      t.createdAt,
      t.id,
    ),
  ],
);
