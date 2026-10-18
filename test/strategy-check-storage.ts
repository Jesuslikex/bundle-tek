import { strategyCapacityStorage } from './strategy-capacity-storage';
export async function strategyCheckStorage() {
  const store = await strategyCapacityStorage();
  await store.client.execute(
    'CREATE TABLE market_read_gates (owner_id TEXT PRIMARY KEY NOT NULL,next_allowed_at INTEGER NOT NULL)',
  );
  return store;
}
