import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { createTursoDatabase } from '@/db/turso';
import { generateKeyPairSigner } from '@solana/kit';
import { PumpPreflightError } from '@/lib/owned-pump-preflight';
const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
  plan: vi.fn(async (..._a: unknown[]) => ({ id: 'seq', state: 'active' })),
  prepare: vi.fn(async (..._a: unknown[]) => ({ id: 'batch' })),
  register: vi.fn(async (..._a: unknown[]) => ({ state: 'signed' })),
  send: vi.fn(async (..._a: unknown[]) => ({ state: 'signed' })),
  observe: vi.fn(async (..._a: unknown[]) => ({ state: 'closed' })),
  stop: vi.fn(async (..._a: unknown[]) => ({ state: 'stopped' })),
  list: vi.fn(async (..._a: unknown[]) => []),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/pump-launch-service', () => ({ pumpLaunchRpc: () => vi.fn() }));
vi.mock('@/lib/pump-organic-preparation', () => ({
  planOwnedPumpOrganicSequence: mocks.plan,
  preparePumpOrganicBatch: mocks.prepare,
}));
vi.mock('@/lib/pump-organic-service', () => ({
  listPumpOrganicSequences: mocks.list,
  registerPumpOrganicBatch: mocks.register,
  sendPumpOrganicBuy: mocks.send,
  observePumpOrganicBatch: mocks.observe,
  stopPumpOrganicSequence: mocks.stop,
}));
import { GET, POST } from './route';

let client: Client, holder: string;
const origin = 'https://bundle.test',
  id = '00000000-0000-4000-8000-000000000001';
beforeAll(async () => {
  client = createClient({ url: 'file::memory:' });
  await client.execute(
    'CREATE TABLE imported_token_project_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
  );
  mocks.db = createTursoDatabase(client);
  holder = (await generateKeyPairSigner()).address;
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
    new Request(origin + '/api/launch/pump/organic', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
const planBody = () => ({
  action: 'plan',
  terms: {
    launchReviewId: id,
    mode: 'Organic',
    buys: [{ address: holder, tokenAmountRaw: '1000' }],
    delayMinMs: 1000,
    delayMaxMs: 5000,
    slippageBps: 500,
    rentAllowanceRaw: '3000000',
  },
});

it('requires a signed-in same-origin JSON request', async () => {
  mocks.user = null;
  expect((await post(planBody())).status).toBe(401);
  mocks.user = { userId: 'alice' };
  expect((await post(planBody(), { origin: 'https://evil.test' })).status).toBe(
    403,
  );
  expect(
    (await post(planBody(), { 'content-type': 'text/plain' })).status,
  ).toBe(415);
  expect(mocks.plan).not.toHaveBeenCalled();
});

it('routes each action to the owned service with the session owner', async () => {
  expect((await post(planBody())).status).toBe(200);
  expect(mocks.plan.mock.calls[0][1]).toBe('alice');
  await post({ action: 'prepare-batch', sequenceId: id, batch: 0 });
  expect(mocks.prepare.mock.calls[0].slice(1, 4)).toEqual(['alice', id, 0]);
  await post({ action: 'send', batchId: id, index: 1, sendApproved: true });
  expect(mocks.send.mock.calls[0].slice(1, 4)).toEqual(['alice', id, 1]);
  await post({ action: 'observe', batchId: id });
  await post({ action: 'stop', sequenceId: id });
  expect(mocks.observe).toHaveBeenCalledTimes(1);
  expect(mocks.stop).toHaveBeenCalledTimes(1);
});

it('rejects loose payloads, missing send approval and rapid repeats', async () => {
  expect((await post({ ...planBody(), extra: 1 })).status).toBe(400);
  expect((await post({ action: 'send', batchId: id, index: 0 })).status).toBe(
    400,
  );
  expect(
    (
      await post({
        ...planBody(),
        terms: {
          ...planBody().terms,
          buys: [{ address: 'x', tokenAmountRaw: '1' }],
        },
      })
    ).status,
  ).toBe(400);
  expect((await post(planBody())).status).toBe(200);
  expect((await post(planBody())).status).toBe(429);
  mocks.plan.mockRejectedValueOnce(new PumpPreflightError('nope', 404));
});

it('lists owned history by project', async () => {
  const response = await GET(
    new Request(origin + '/api/launch/pump/organic?projectId=p1'),
  );
  expect(await response.json()).toEqual({ sequences: [] });
  expect(mocks.list.mock.calls[0].slice(1)).toEqual(['alice', 'p1']);
});
