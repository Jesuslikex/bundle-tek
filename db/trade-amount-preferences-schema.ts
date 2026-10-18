import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const tradeAmountPreferences = sqliteTable('trade_amount_preferences', {
  ownerId: text('owner_id').primaryKey().notNull(),
  revision: integer('revision').notNull(),
  document: text('document').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
