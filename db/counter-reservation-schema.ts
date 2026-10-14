import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/sqlite-core';
export const counterProposalReservations = sqliteTable(
  'counter_proposal_reservations',
  {
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    planId: text('plan_id').notNull(),
    decisionIdentity: text('decision_identity').notNull(),
    id: text('id').notNull(),
    projectRevision: integer('project_revision').notNull(),
    planRevision: integer('plan_revision').notNull(),
    walletAddress: text('wallet_address').notNull(),
    walletRevision: integer('wallet_revision').notNull(),
    packetSha256: text('packet_sha256').notNull(),
    document: text('document').notNull(),
    expiresAt: text('expires_at').notNull(),
    approvalId: text('approval_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.ownerId, t.projectId, t.planId, t.decisionIdentity],
    }),
    uniqueIndex('counter_proposal_reservation_id').on(t.id),
    uniqueIndex('counter_proposal_reservation_approval').on(t.approvalId),
    index('counter_proposal_reservation_scope').on(
      t.ownerId,
      t.projectId,
      t.planId,
    ),
  ],
);
