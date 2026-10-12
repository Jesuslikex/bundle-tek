import { beforeAll, afterAll, beforeEach, it, expect, vi } from 'vitest';
import { Miniflare } from 'miniflare';
const mocks = vi.hoisted(() => ({
  user: null as { userId: string } | null,
  db: null as unknown as D1Database,
  observe: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/wallet-warmup-history', () => ({
  observeWarmupHistory: mocks.observe,
}));
import { POST } from './route';
let mf: Miniflare;
const address = '0x1111111111111111111111111111111111111111';
const request = (
  body: unknown = { chain: 'Base', addresses: [address] },
  headers = {},
) =>
  POST(
    new Request('http://localhost/api/wallet-workspace/warmup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'warmup-test',
          type: 'worker',
          compatibilityDate: '2026-09-01',
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': {
                type: 'esm',
                contents: 'export default {fetch(){return new Response("ok")}}',
              },
            },
          },
          env: { DB: { type: 'd1', id: 'warmup-test-db' } },
        },
      },
    ],
  });
  mocks.db = (await mf.getD1Database(
    'DB',
    'warmup-test',
  )) as unknown as D1Database;
  await mocks.db
    .prepare(
      'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER)',
    )
    .run();
  await mocks.db
    .prepare(
      'CREATE TABLE wallet_balance_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
    )
    .run();
});
afterAll(async () => mf.dispose());
beforeEach(async () => {
  mocks.user = { userId: 'one' };
  mocks.observe.mockReset();
  await mocks.db.exec(
    'DELETE FROM workspace_wallets; DELETE FROM wallet_balance_gates;',
  );
  await mocks.db
    .prepare('INSERT INTO workspace_wallets VALUES (?,?,?,?,?)')
    .bind('one', 'Base', address, 1, 0)
    .run();
  mocks.observe.mockResolvedValue({ address, chain: 'Base' });
});
it('requires authentication, same origin and active ownership before RPC', async () => {
  mocks.user = null;
  expect((await request()).status).toBe(401);
  mocks.user = { userId: 'two' };
  expect((await request()).status).toBe(404);
  mocks.user = { userId: 'one' };
  expect(
    (await request(undefined, { origin: 'https://other.test' })).status,
  ).toBe(403);
  await mocks.db.exec('UPDATE workspace_wallets SET archived=1');
  expect((await request()).status).toBe(404);
  expect(mocks.observe).not.toHaveBeenCalled();
});
it('shares the wallet-read throttle and refuses a revision changed during RPC', async () => {
  expect((await request()).status).toBe(200);
  expect((await request()).status).toBe(429);
  await mocks.db.exec('DELETE FROM wallet_balance_gates');
  mocks.observe.mockImplementation(async () => {
    await mocks.db.exec('UPDATE workspace_wallets SET revision=2');
    return { address };
  });
  expect((await request()).status).toBe(409);
});
it('returns provider failures without exposing upstream messages or fake observations', async () => {
  mocks.observe.mockRejectedValue(new Error('secret-provider-value'));
  const response = await request();
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain('secret-provider-value');
  expect(text).not.toContain('observation');
  expect(text).toContain('No readiness conclusion');
  expect(
    (await request({ chain: 'Base', addresses: Array(21).fill(address) }))
      .status,
  ).toBe(400);
});
