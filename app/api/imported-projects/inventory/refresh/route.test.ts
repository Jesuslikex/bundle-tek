import { beforeAll, beforeEach, afterAll, it, expect, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import bs58 from 'bs58';
import { inventoryFixture } from '../../../../../test/imported-wallet-inventory-fixture';
import { HoldingsReadError } from '@/lib/wallet-holdings';
const mocks = vi.hoisted(() => ({
  user: null as { userId: string } | null,
  db: null as unknown as D1Database,
  read: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/wallet-holdings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/wallet-holdings')>()),
  observeWalletHoldings: mocks.read,
}));
import { POST } from './route';
const id = '00000000-0000-4000-8000-000000000001',
  mint = inventoryFixture().holdings[0].mint;
const wallets = Array.from({ length: 25 }, (_, i) => ({
  address: bs58.encode(new Uint8Array(32).fill(i + 1)),
  revision: 1,
}));
let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'group-inventory-tests',
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
          env: { DB: { type: 'd1', id: 'group-inventory-test-only' } },
        },
      },
    ],
  });
  mocks.db = await mf.getD1Database('DB', 'group-inventory-tests');
  for (const sql of [
    'CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,revision INTEGER,chain TEXT,archived INTEGER,document TEXT)',
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER)',
    'CREATE TABLE wallet_holdings_snapshots(owner_id TEXT,chain TEXT,address TEXT,document TEXT,max_slot INTEGER,PRIMARY KEY(owner_id,chain,address))',
    'CREATE TABLE wallet_balance_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
  ])
    await mocks.db.prepare(sql).run();
});
afterAll(async () => mf?.dispose());
beforeEach(async () => {
  mocks.user = { userId: 'one' };
  mocks.read.mockReset();
  mocks.read.mockImplementation(async (address: string) => ({
    ...inventoryFixture(),
    address,
    observedAt: new Date().toISOString(),
  }));
  for (const table of [
    'imported_token_projects',
    'workspace_wallets',
    'wallet_holdings_snapshots',
    'wallet_balance_gates',
  ])
    await mocks.db.prepare('DELETE FROM ' + table).run();
  await mocks.db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,1,?,0,?)')
    .bind(
      'one',
      id,
      'Solana',
      JSON.stringify({ token: { address: mint, decimals: 6 } }),
    )
    .run();
  for (const w of wallets)
    await mocks.db
      .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,1,0)')
      .bind('one', 'Solana', w.address)
      .run();
});
const request = (
  body: unknown = { id, revision: 1, wallets: wallets.slice(0, 2) },
  origin = 'http://localhost',
) =>
  new Request('http://localhost/api/imported-projects/inventory/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  });
const stored = () =>
  mocks.db
    .prepare(
      'SELECT address,document,max_slot FROM wallet_holdings_snapshots ORDER BY address',
    )
    .all<{ address: string; document: string; max_slot: number }>();
it('rejects unauthenticated, foreign, cross-origin and changed selections before providers', async () => {
  mocks.user = null;
  expect((await POST(request())).status).toBe(401);
  mocks.user = { userId: 'two' };
  expect((await POST(request())).status).toBe(409);
  mocks.user = { userId: 'one' };
  expect((await POST(request(undefined, 'https://foreign.test'))).status).toBe(
    403,
  );
  expect(
    (
      await POST(
        request({ id, revision: 1, wallets: [wallets[0], wallets[0]] }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await POST(
        request({ id, revision: 1, wallets: [{ ...wallets[0], revision: 2 }] }),
      )
    ).status,
  ).toBe(409);
  expect(mocks.read).not.toHaveBeenCalled();
});
it('persists the whole group and replaces existing rows atomically, sharing the refresh gate', async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  const data = (await response.json()) as {
    items: Array<{ observation: { unfrozenRaw: string } }>;
  };
  expect(data.items).toHaveLength(2);
  expect(data.items.every((i) => i.observation.unfrozenRaw === '3003')).toBe(
    true,
  );
  expect((await stored()).results).toHaveLength(2);
  expect((await POST(request())).status).toBe(429);
  await mocks.db
    .prepare('UPDATE wallet_balance_gates SET next_allowed_at=0')
    .run();
  mocks.read.mockImplementation(async (address: string) => {
    const s = inventoryFixture();
    return {
      ...s,
      address,
      minSlot: 200,
      maxSlot: 201,
      slots: s.slots.map((v, i) => ({ ...v, slot: 200 + i })),
      observedAt: new Date().toISOString(),
    };
  });
  expect((await POST(request())).status).toBe(200);
  expect((await stored()).results.every((r) => r.max_slot === 201)).toBe(true);
});
it('saves nothing when provider failure or a wallet revision changes during reads', async () => {
  mocks.read.mockRejectedValueOnce(new Error('private provider detail'));
  const failed = await POST(request());
  expect(failed.status).toBe(502);
  expect(await failed.text()).not.toContain('private provider detail');
  expect((await stored()).results).toHaveLength(0);
  await mocks.db
    .prepare('UPDATE wallet_balance_gates SET next_allowed_at=0')
    .run();
  mocks.read.mockImplementation(async (address: string) => {
    await mocks.db
      .prepare('UPDATE workspace_wallets SET revision=2 WHERE address=?')
      .bind(wallets[0].address)
      .run();
    return {
      ...inventoryFixture(),
      address,
      observedAt: new Date().toISOString(),
    };
  });
  expect((await POST(request())).status).toBe(409);
  expect((await stored()).results).toHaveLength(0);
});
it('keeps every existing observation when one incoming wallet would regress retained slots', async () => {
  await mocks.db
    .prepare('INSERT INTO wallet_holdings_snapshots VALUES(?,?,?,?,?)')
    .bind('one', 'Solana', wallets[0].address, 'old', 500)
    .run();
  expect((await POST(request())).status).toBe(409);
  expect((await stored()).results).toEqual([
    { address: wallets[0].address, document: 'old', max_slot: 500 },
  ]);
});
it('refreshes all 25 wallets with concurrency capped at three', async () => {
  let active = 0,
    maximum = 0;
  mocks.read.mockImplementation(async (address: string) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return {
      ...inventoryFixture(),
      address,
      observedAt: new Date().toISOString(),
    };
  });
  expect((await POST(request({ id, revision: 1, wallets }))).status).toBe(200);
  expect(mocks.read).toHaveBeenCalledTimes(25);
  expect(maximum).toBeLessThanOrEqual(3);
  expect((await stored()).results).toHaveLength(25);
});
it('rejects a project change during provider reads without saving any wallet', async () => {
  mocks.read.mockImplementation(async (address: string) => {
    await mocks.db
      .prepare('UPDATE imported_token_projects SET archived=1')
      .run();
    return {
      ...inventoryFixture(),
      address,
      observedAt: new Date().toISOString(),
    };
  });
  expect((await POST(request())).status).toBe(409);
  expect((await stored()).results).toHaveLength(0);
});
it('withholds malformed group observations before persistence', async () => {
  mocks.read.mockImplementation(async (address: string) => {
    const snapshot = {
      ...inventoryFixture(),
      address,
      observedAt: new Date().toISOString(),
    };
    if (address === wallets[1].address) snapshot.accountCount = 3;
    return snapshot;
  });
  expect((await POST(request())).status).toBe(503);
  expect((await stored()).results).toHaveLength(0);
});
it('returns safe response-limit diagnostics with the affected wallet and retains prior observations', async () => {
  mocks.read.mockRejectedValueOnce(
    new HoldingsReadError(
      'getTokenAccountsByOwner',
      'rpc.test',
      null,
      'RESULT_TOO_LARGE',
    ),
  );
  const response = await POST(request());
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({
    code: 'RESULT_TOO_LARGE',
    wallet: wallets[0].address,
    error: expect.stringContaining('supported holdings response limit'),
  });
  expect((await stored()).results).toHaveLength(0);
});
