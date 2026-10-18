import {
  foreignKey,
  index,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import { pumpGroupReceiptEvidence } from './pump-receipt-evidence-schema';
import { pumpLaunchReviews } from './pump-launch-schema';
export const pumpPurchaseCostBatches = sqliteTable(
  'pump_purchase_cost_batches',
  {
    ownerId: text('owner_id').notNull(),
    receiptId: text('receipt_id').notNull(),
    reviewId: text('review_id')
      .notNull()
      .references(() => pumpLaunchReviews.id),
    parent: text('parent').notNull(),
    costs: text('costs').notNull(),
    plan: text('plan').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.receiptId] }),
    index('pump_purchase_cost_batches_scope').on(
      t.ownerId,
      t.reviewId,
      t.receiptId,
    ),
    foreignKey({
      columns: [t.ownerId, t.receiptId],
      foreignColumns: [
        pumpGroupReceiptEvidence.ownerId,
        pumpGroupReceiptEvidence.id,
      ],
    }),
  ],
);
export const pumpPurchaseCostSources = sqliteTable(
  'pump_purchase_cost_sources',
  {
    ownerId: text('owner_id').notNull(),
    originId: text('origin_id').notNull(),
    receiptId: text('receipt_id').notNull(),
    reviewId: text('review_id').notNull(),
    mint: text('mint').notNull(),
    wallet: text('wallet').notNull(),
    source: text('source').notNull(),
    sha256: text('sha256').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.originId] }),
    foreignKey({
      columns: [t.ownerId, t.receiptId],
      foreignColumns: [
        pumpPurchaseCostBatches.ownerId,
        pumpPurchaseCostBatches.receiptId,
      ],
    }),
    index('pump_purchase_cost_sources_scope').on(
      t.ownerId,
      t.reviewId,
      t.originId,
    ),
    index('pump_purchase_cost_sources_inventory').on(
      t.ownerId,
      t.mint,
      t.wallet,
      t.originId,
    ),
  ],
);
