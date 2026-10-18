import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { strategyCheckStorage } from '../../../../test/strategy-check-storage';
import {
  strategyInput,
  strategyProject,
} from '../../../../test/strategy-session-fixture';
import {
  checkDraftId,
  checkHoldId,
  strategyMarketText,
} from '../../../../test/strategy-check-fixture';
import { saveStrategyDraft } from '@/lib/strategy-session-drafts';
import { changeStrategyReviewCapacity } from '@/lib/strategy-review-capacity-server';
import { POST } from './route';
const state = vi.hoisted(() => ({
  user: 'owner' as string | null,
  db: null as D1Database | null,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => (state.user ? { userId: state.user } : null),
}));
vi.mock('@/db', () => ({ getD1: () => state.db }));
let store: Awaited<ReturnType<typeof strategyCheckStorage>>;
const body = {
  projectId: strategyProject,
  draftId: checkDraftId,
  revision: 1,
  holdId: checkHoldId,
};
const post = (value: unknown, origin = 'https://bundle.test') =>
  POST(
    new Request('https://bundle.test/api/imported-projects/strategy-checks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify(value),
    }),
  );
beforeEach(async () => {
  store = await strategyCheckStorage();
  state.db = store.db;
  state.user = 'owner';
  const input = strategyInput();
  input.startAt = new Date(Date.now() - 120000).toISOString();
  await saveStrategyDraft(store.db, 'owner', checkDraftId, input);
  await changeStrategyReviewCapacity(
    store.db,
    'owner',
    strategyProject,
    checkDraftId,
    0,
    {
      kind: 'hold',
      id: checkHoldId,
      strategyId: input.strategies[1].id,
      candidate: 0,
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(strategyMarketText('100000'))),
  );
});
afterEach(() => {
  store.client.close();
  vi.unstubAllGlobals();
});
it('authenticates before storage/provider access', async () => {
  state.user = null;
  state.db = null;
  const response = await post(body);
  expect(response.status).toBe(401);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(fetch).not.toHaveBeenCalled();
});
it('checks the actual owned slot with the production adapter and fixed-host provider decoder', async () => {
  const response = await post(body);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    draftId: checkDraftId,
    holdId: checkHoldId,
    status: 'market-observed',
    pools: [{ condition: 'met' }],
    planningOnly: true,
    signingAllowed: false,
    fundingAllowed: false,
    executionAllowed: false,
  });
  expect((await post(body)).status).toBe(429);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('refuses foreign and released slots before provider IO', async () => {
  state.user = 'foreign';
  expect((await post(body)).status).toBe(404);
  state.user = 'owner';
  await changeStrategyReviewCapacity(
    store.db,
    'owner',
    strategyProject,
    checkDraftId,
    1,
    { kind: 'release', id: checkHoldId },
  );
  expect((await post(body)).status).toBe(409);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  { ...body, executionAllowed: true },
  { ...body, observation: { marketCap: '100000' } },
  { ...body, action: 'submit' },
  { ...body, revision: '1' },
])(
  'refuses client-supplied authority, market evidence or malformed context %j',
  async (value) => {
    expect((await post(value)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  },
);
it('rejects cross-origin and oversized bodies', async () => {
  expect((await post(body, 'https://foreign.test')).status).toBe(400);
  expect((await post({ ...body, padding: 'x'.repeat(5000) })).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});
it('sanitizes provider HTML and unavailable storage without changing review slots', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response('private upstream response', { status: 503 }),
    ),
  );
  const provider = await post(body);
  expect(provider.status).toBe(502);
  expect(JSON.stringify(await provider.json())).not.toContain(
    'private upstream',
  );
  state.db = null;
  const storage = await post(body);
  expect(storage.status).toBe(503);
  expect(await storage.json()).toEqual({
    error: 'Strategy condition check unavailable. No review slots changed.',
  });
});
