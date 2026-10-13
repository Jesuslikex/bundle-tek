import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
export const jitoBundles = sqliteTable(
  'jito_bundles',
  {
    ownerId: text('owner_id').notNull(),
    id: text('id').notNull(),
    projectId: text('project_id').notNull(),
    sessionId: text('session_id').notNull(),
    document: text('document').notNull(),
    state: text('state').notNull(),
    bundleId: text('bundle_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.id] }),
    index('jito_bundles_project').on(t.ownerId, t.projectId, t.createdAt),
  ],
);
export const jitoBundleFinalizations = sqliteTable(
  'jito_bundle_finalizations',
  {
    ownerId: text('owner_id').notNull(),
    bundleId: text('bundle_id').notNull(),
    document: text('document').notNull(),
    observedAt: text('observed_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.bundleId] })],
);
export const jitoBundlePackets = sqliteTable(
  'jito_bundle_packets',
  {
    ownerId: text('owner_id').notNull(),
    bundleId: text('bundle_id').notNull(),
    packet: integer('packet').notNull(),
    intentId: text('intent_id'),
    transaction: text('transaction'),
    signature: text('signature'),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.bundleId, t.packet] }),
    uniqueIndex('jito_bundle_intent').on(t.ownerId, t.intentId),
  ],
);
export const jitoBundleEvents = sqliteTable(
  'jito_bundle_events',
  {
    sequence: integer('sequence').primaryKey({ autoIncrement: true }),
    id: text('id').notNull(),
    ownerId: text('owner_id').notNull(),
    bundleId: text('bundle_id').notNull(),
    projectId: text('project_id').notNull(),
    sessionId: text('session_id').notNull(),
    type: text('type').notNull(),
    packet: integer('packet'),
    document: text('document').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('jito_bundle_event_identity').on(t.ownerId, t.id),
    index('jito_bundle_events_owner').on(t.ownerId, t.createdAt, t.sequence),
    index('jito_bundle_events_bundle').on(
      t.ownerId,
      t.bundleId,
      t.createdAt,
      t.sequence,
    ),
  ],
);
