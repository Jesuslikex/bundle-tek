import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { strategyCapacityStorage } from '../../../../test/strategy-capacity-storage';
import {
  strategyInput,
  strategyProject,
} from '../../../../test/strategy-session-fixture';
import { saveStrategyDraft } from '@/lib/strategy-session-drafts';
import { GET, POST } from './route';
const state = vi.hoisted(() => ({
  user: 'owner' as string | null,
  db: null as D1Database | null,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => (state.user ? { userId: state.user } : null),
}));
vi.mock('@/db', () => ({ getD1: () => state.db }));
let store: Awaited<ReturnType<typeof strategyCapacityStorage>>;
const draftId = '00000000-0000-4000-8000-000000000099',
  holdId = '00000000-0000-4000-8000-000000000098';
const body = () => ({
  projectId: strategyProject,
  draftId,
  revision: 0,
  event: {
    kind: 'hold',
    id: holdId,
    strategyId: strategyInput().strategies[0].id,
    candidate: 0,
  },
});
const get = (query = `projectId=${strategyProject}&draftId=${draftId}`) =>
  GET(
    new Request(
      `https://bundle.test/api/imported-projects/strategy-capacity?${query}`,
    ),
  );
const post = (value: unknown, origin = 'https://bundle.test') =>
  POST(
    new Request('https://bundle.test/api/imported-projects/strategy-capacity', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(value),
    }),
  );
beforeEach(async () => {
  store = await strategyCapacityStorage();
  state.db = store.db;
  state.user = 'owner';
  const input = strategyInput();
  input.startAt = new Date(Date.now() + 1800000).toISOString();
  await saveStrategyDraft(store.db, 'owner', draftId, input);
});
afterEach(() => store.client.close());
it('requires authentication before storage and has no cached capacity response', async () => {
  state.user = null;
  state.db = null;
  for (const response of [await get(), await post(body())]) {
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
});
it('runs the actual owned save/reload/release API against the production DB adapter', async () => {
  expect(await (await get()).json()).toMatchObject({ revision: 0 });
  const response = await post(body());
  expect(response.status).toBe(200);
  const saved = await response.json();
  expect(saved).toMatchObject({
    revision: 1,
    executionAllowed: false,
    fundingAllowed: false,
    signingAllowed: false,
    summary: { heldRaw: '5000000' },
  });
  expect(await (await get()).json()).toEqual(saved);
  const released = await post({
    ...body(),
    revision: 1,
    event: { kind: 'release', id: holdId },
  });
  expect(released.status).toBe(200);
  expect(await released.json()).toMatchObject({
    revision: 2,
    summary: { heldRaw: '0' },
  });
  expect(await (await post(body())).json()).toMatchObject({ revision: 2 });
});
it('keeps foreign ownership private for history and mutations', async () => {
  state.user = 'foreign';
  expect((await get()).status).toBe(404);
  expect((await post(body())).status).toBe(404);
});
it.each(['run', 'submit', 'attempted', 'settled'])(
  'rejects unsupported %s authority actions',
  async (kind) => {
    expect(
      (await post({ ...body(), event: { ...body().event, kind } })).status,
    ).toBe(400);
  },
);
it('rejects unknown fields, duplicate query, oversized and cross-origin writes', async () => {
  expect((await post({ ...body(), executionAllowed: true })).status).toBe(400);
  expect(
    (await post({ ...body(), event: { ...body().event, unitsRaw: '1' } }))
      .status,
  ).toBe(400);
  expect((await post(body(), 'https://foreign.test')).status).toBe(400);
  expect((await post({ ...body(), padding: 'x'.repeat(13000) })).status).toBe(
    400,
  );
  expect(
    (
      await get(
        `projectId=${strategyProject}&draftId=${draftId}&draftId=${draftId}`,
      )
    ).status,
  ).toBe(400);
});
it('sanitizes unavailable storage without implying a confirmed cancellation', async () => {
  state.db = null;
  const response = await post(body());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error:
      'Review capacity storage unavailable. Reload to recover the last saved state. No trades started.',
  });
});
