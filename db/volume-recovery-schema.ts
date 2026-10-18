import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { volumeBundleReservations } from './volume-bundle-schema';
export const volumeBundleRecoveryPackets = sqliteTable(
  'volume_bundle_recovery_packets',
  {
    reservationId: text('reservation_id')
      .primaryKey()
      .notNull()
      .references(() => volumeBundleReservations.id),
    ownerId: text('owner_id').notNull(),
    attemptId: text('attempt_id').notNull(),
    signature: text('signature').notNull(),
    packet: text('packet').notNull(),
    packetSha256: text('packet_sha256').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('volume_bundle_recovery_signature').on(t.signature)],
);
export const volumeBundleSettlements = sqliteTable(
  'volume_bundle_settlements',
  {
    reservationId: text('reservation_id')
      .primaryKey()
      .notNull()
      .references(() => volumeBundleReservations.id),
    ownerId: text('owner_id').notNull(),
    signature: text('signature').notNull(),
    document: text('document').notNull(),
    sha256: text('sha256').notNull(),
    tipSpent: integer('tip_spent').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('volume_bundle_settlement_signature').on(t.signature)],
);
