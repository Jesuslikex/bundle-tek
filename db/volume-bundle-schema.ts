import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
export const volumeBundleSessions = sqliteTable(
  'volume_bundle_sessions',
  {
    id: text('id').primaryKey().notNull(),
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    projectRevision: integer('project_revision').notNull(),
    revision: integer('revision').notNull(),
    mint: text('mint').notNull(),
    plan: text('plan').notNull(),
    planSha256: text('plan_sha256').notNull(),
    wallets: text('wallets').notNull(),
    tipBudget: integer('tip_budget').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('volume_bundle_sessions_owner').on(
      t.ownerId,
      t.projectId,
      t.createdAt,
    ),
  ],
);
export const volumeBundleReservations = sqliteTable(
  'volume_bundle_reservations',
  {
    id: text('id').primaryKey().notNull(),
    ownerId: text('owner_id').notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => volumeBundleSessions.id),
    sessionRevision: integer('session_revision').notNull(),
    round: integer('round').notNull(),
    wallet: text('wallet').notNull(),
    walletRevision: integer('wallet_revision').notNull(),
    constructionSha256: text('construction_sha256').notNull(),
    runtimeSha256: text('runtime_sha256').notNull(),
    document: text('document').notNull(),
    tipCap: integer('tip_cap').notNull(),
    state: text('state').notNull(),
    attemptId: text('attempt_id'),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('volume_bundle_reservations_owner').on(
      t.ownerId,
      t.sessionId,
      t.createdAt,
    ),
    uniqueIndex('volume_bundle_active_round')
      .on(t.sessionId, t.round)
      .where(sql`${t.state} IN ('held','attempted')`),
    uniqueIndex('volume_bundle_wallet_lock')
      .on(t.ownerId, t.wallet)
      .where(sql`${t.state} IN ('held','attempted')`),
    uniqueIndex('volume_bundle_attempt_id').on(t.ownerId, t.attemptId),
  ],
);
export const volumeBundleReservationEvents = sqliteTable(
  'volume_bundle_reservation_events',
  {
    sequence: integer('sequence').primaryKey({ autoIncrement: true }),
    reservationId: text('reservation_id')
      .notNull()
      .references(() => volumeBundleReservations.id),
    ownerId: text('owner_id').notNull(),
    state: text('state').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('volume_bundle_reservation_event_state').on(
      t.reservationId,
      t.state,
    ),
  ],
);
