import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { createTursoDatabase } from '@/db/turso';
const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
  estimate: vi.fn(async (..._a: unknown[]) => ({ plan: {} })),
  create: vi.fn(async (..._a: unknown[]) => ({ id: 's', state: 'active' })),
  prepare: vi.fn(async (..._a: unknown[]) => ({ id: 's' })),
  register: vi.fn(async (..._a: unknown[]) => ({ id: 's' })),
  send: vi.fn(async (..._a: unknown[]) => ({ id: 's' })),
  observe: vi.fn(async (..._a: unknown[]) => ({ id: 's' })),
  cancel: vi.fn(async (..._a: unknown[]) => ({ state: 'cancelled' })),
  list: vi.fn(async (..._a: unknown[]) => []),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/solana-rpc', () => ({
  getSolanaIndexerRpcEndpoint: () => 'https://rpc.test/',
}));
vi.mock('@/lib/volume-bot-service', async (original) => ({
  ...(await original<typeof import('@/lib/volume-bot-service')>()),
  estimateVolumeSession: mocks.estimate,
  createVolumeSession: mocks.create,
  prepareVolumeBatch: mocks.prepare,
  registerVolumeBatch: mocks.register,
  sendVolumeTrade: mocks.send,
  observeVolumeBatch: mocks.observe,
  cancelVolumeSession: mocks.cancel,
  listVolumeSessions: mocks.list,
}));
import { GET, POST } from './route';

let client: Client;
const origin = 'https://bundle.test',
  id = '00000000-0000-4000-8000-000000000001';
const wallet = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
beforeAll(async () => {
  client = createClient({ url: 'file::memory:' });
  await client.execute(
    'CREATE TABLE imported_token_project_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
  );
  mocks.db = createTursoDatabase(client);
});
afterAll(() => client.close());
beforeEach(async () => {
  mocks.user = { userId: 'alice' };
  await client.execute('DELETE FROM imported_token_project_gates');
  for (const m of Object.values(mocks))
    if (typeof m === 'function' && 'mockClear' in m) m.mockClear();
});
const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request(origin + '/api/imported-projects/volume-bot', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
const estimate = {
  action: 'estimate',
  projectId: id,
  projectRevision: 1,
  seed: '0123456789abcdef0123456789abcdef',
  terms: {
    targetVolumeLamports: '400000000',
    durationSeconds: 600,
    delayMinMs: 2000,
    delayMaxMs: 3000,
    amount: { kind: 'auto' },
    wave: 'tight',
    wallets: [wallet],
  },
};

it('requires sign-in, same origin and JSON', async () => {
  mocks.user = null;
  expect((await post(estimate)).status).toBe(401);
  mocks.user = { userId: 'alice' };
  expect((await post(estimate, { origin: 'https://evil.test' })).status).toBe(
    403,
  );
  expect((await post(estimate, { 'content-type': 'text/plain' })).status).toBe(
    415,
  );
  expect(mocks.estimate).not.toHaveBeenCalled();
});

it('parses strict actions and rate-gates provider work per owner', async () => {
  expect((await post(estimate)).status).toBe(200);
  expect(mocks.estimate.mock.calls[0][1]).toBe('alice');
  expect((await post({ ...estimate, action: 'create' })).status).toBe(429);
  expect(
    (await post({ action: 'send', batchId: id, index: 0 })).status,
  ).toBe(200);
  expect(mocks.send).toHaveBeenCalledOnce();
  expect((await post({ action: 'cancel', sessionId: id })).status).toBe(200);
  expect(
    (await post({ action: 'send', batchId: id, index: 0, extra: 1 })).status,
  ).toBe(400);
  const bad = await post({
    ...estimate,
    terms: { ...estimate.terms, delayMaxMs: 1000 },
  });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toMatch(/maximum delay/);
});

it('lists sessions only for a valid project id', async () => {
  expect(
    (await GET(new Request(origin + '/api/imported-projects/volume-bot'))).status,
  ).toBe(400);
  const ok = await GET(
    new Request(origin + `/api/imported-projects/volume-bot?projectId=${id}`),
  );
  expect(ok.status).toBe(200);
  expect(mocks.list.mock.calls[0]).toEqual([mocks.db, 'alice', id]);
});
