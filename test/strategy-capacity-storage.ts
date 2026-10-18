import { readFileSync } from 'node:fs';
import { strategyDraftStorage } from './strategy-session-draft-storage';
export async function strategyCapacityStorage() {
  const store = await strategyDraftStorage();
  for (const sql of readFileSync(
    'drizzle/0110_strategy_review_capacity.sql',
    'utf8',
  ).split('--> statement-breakpoint'))
    if (sql.trim()) await store.client.execute(sql);
  return store;
}
