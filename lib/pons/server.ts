import { observeReceipt } from './receipt';
import { env } from '@/lib/server-env';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { PonsStore } from './store';
import { handlePons } from './api';
import { ponsClient } from './runtime';
import { simulateIntent } from './simulation';
export function ponsRoute(
  request: Request,
  action: 'create' | 'get' | 'simulate' | 'handoff' | 'receipt',
  id?: string,
) {
  return handlePons(request, action, id, {
    owner: async () => (await getChatGPTUser())?.userId ?? null,
    enabled:
      (env as unknown as Record<string, unknown>).PONS_BACKEND_ENABLED ===
      'true',
    store: async () => {
      const store = new PonsStore(getD1());
      await store.ensure();
      return store;
    },
    simulate: (intent, signal) => simulateIntent(intent, ponsClient(signal)),
    observe: (stored, hash, signal) =>
      observeReceipt(stored, hash, ponsClient(signal)),
  });
}
