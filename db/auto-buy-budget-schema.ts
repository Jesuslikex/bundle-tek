// Custom SQL migration owns CHECKs, scope/aggregate guards and signing isolation.
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  uniqueIndex,
  index,
  foreignKey,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
export const autoBuyBudgets = sqliteTable(
  'auto_buy_budgets',
  {
    ownerId: text('owner_id').notNull(),
    id: text('id').notNull(),
    projectId: text('project_id').notNull(),
    projectRevision: integer('project_revision').notNull(),
    document: text('document').notNull(),
    documentSha256: text('document_sha256').notNull(),
    maximumInputLamports: integer('maximum_input_lamports').notNull(),
    maximumFeeAndRentLamports: integer(
      'maximum_fee_and_rent_lamports',
    ).notNull(),
    state: text('state').notNull().default('open'),
    revision: integer('revision').notNull().default(0),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.id] }),
    uniqueIndex('auto_buy_budget_id').on(t.id),
  ],
);
export const autoBuyBudgetClaims = sqliteTable(
  'auto_buy_budget_claims',
  {
    ownerId: text('owner_id').notNull(),
    id: text('id').notNull(),
    sessionId: text('session_id').notNull(),
    strategyId: text('strategy_id').notNull(),
    wallet: text('wallet').notNull(),
    walletRevision: integer('wallet_revision').notNull(),
    candidateKey: text('candidate_key').notNull(),
    kind: text('kind').notNull(),
    sourceSha256: text('source_sha256').notNull(),
    packetSha256: text('packet_sha256').notNull(),
    minimumOutputTokenRaw: text('minimum_output_token_raw').notNull(),
    maximumInputLamports: integer('maximum_input_lamports').notNull(),
    maximumFeeAndRentLamports: integer(
      'maximum_fee_and_rent_lamports',
    ).notNull(),
    document: text('document').notNull(),
    documentSha256: text('document_sha256').notNull(),
    state: text('state').notNull().default('held'),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.id] }),
    uniqueIndex('auto_buy_budget_claim_id').on(t.id),
    foreignKey({
      columns: [t.ownerId, t.sessionId],
      foreignColumns: [autoBuyBudgets.ownerId, autoBuyBudgets.id],
    }),
    index('auto_buy_budget_claim_scope').on(t.ownerId, t.sessionId, t.state),
    uniqueIndex('auto_buy_budget_active_candidate')
      .on(t.ownerId, t.sessionId, t.strategyId, t.candidateKey)
      .where(sql`${t.state} != 'released'`),
    uniqueIndex('auto_buy_budget_counter_source')
      .on(t.ownerId, t.sourceSha256, t.candidateKey)
      .where(sql`${t.kind} = 'ExactOut' AND ${t.state} != 'released'`),
    index('auto_buy_budget_packet_history').on(t.ownerId, t.packetSha256),
    uniqueIndex('auto_buy_budget_active_packet')
      .on(t.ownerId, t.packetSha256)
      .where(sql`${t.state} != 'released'`),
  ],
);
