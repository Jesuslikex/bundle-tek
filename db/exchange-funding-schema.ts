import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
export * from './exchange-order-schema';
export const exchangeFundingQuoteGates = sqliteTable(
  'exchange_funding_quote_gates',
  {
    scope: text('scope').primaryKey().notNull(),
    nextAllowedAt: integer('next_allowed_at').notNull(),
    claimId: text('claim_id').notNull(),
  },
);
export const exchangeFundingQuotes = sqliteTable(
  'exchange_funding_quotes',
  {
    id: text('id').primaryKey().notNull(),
    ownerId: text('owner_id').notNull(),
    planId: text('plan_id').notNull(),
    planRevision: integer('plan_revision').notNull(),
    funderRevision: integer('funder_revision').notNull(),
    planDocument: text('plan_document').notNull(),
    review: text('review').notNull(),
    providerReference: text('provider_reference').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (table) => [
    index('idx_exchange_funding_quotes_owner').on(
      table.ownerId,
      table.createdAt,
    ),
  ],
);
