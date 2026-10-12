import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { nativeWarmupFixture } from '../../../../test/warmup-native-fixture';
import { unsignedPreparationSummary } from '@/lib/imported-swap-preparation-history';
const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
  simulate: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/imported-swap-simulation', async (original) => {
  const actual =
    await original<typeof import('@/lib/imported-swap-simulation')>();
  return {
    ...actual,
    simulateImportedSwap: (
      order: unknown,
      signal: AbortSignal,
      fetcher: typeof fetch,
      strict: boolean,
    ) =>
      fetcher !== fetch
        ? actual.simulateImportedSwap(
            order as Parameters<typeof actual.simulateImportedSwap>[0],
            signal,
            fetcher,
            strict,
          )
        : mocks.simulate(order, signal, fetcher, strict),
  };
});
import { POST } from './route';
import { SwapBlockhashExpiredError } from '@/lib/imported-swap-simulation';
let mf: Miniflare;
let fixture: Awaited<ReturnType<typeof nativeWarmupFixture>>;
const projectId = '11111111-1111-4111-8111-111111111111';
const preparationId = '22222222-2222-4222-8222-222222222222';
beforeAll(async () => {
  mf = new Miniflare({
    workers: [
      {
        config: {
          name: 'signing-checks-test',
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
          env: { DB: { type: 'd1', id: 'signing-checks-test-only' } },
        },
      },
    ],
    telemetry: { enabled: false },
  });
  mocks.db = await mf.getD1Database('DB', 'signing-checks-test');
  for (const name of [
    '0024_imported_token_projects',
    '0041_imported_swap_preparations',
  ]) {
    const sql = await readFile(
      new URL(`../../../../drizzle/${name}.sql`, import.meta.url),
      'utf8',
    );
    for (const statement of sql
      .split('--> statement-breakpoint')
      .filter((s) => s.trim()))
      await mocks.db.prepare(statement).run();
  }
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
  fixture = await nativeWarmupFixture({ lookup: true, v2: true });
});
afterAll(async () => {
  await mf?.dispose();
});
beforeEach(async () => {
  mocks.user = { userId: 'alice' };
  mocks.simulate.mockReset().mockResolvedValue(fixture.simulation);
  for (const table of [
    'imported_token_projects',
    'imported_swap_preparations',
    'workspace_wallets',
    'wallet_balance_gates',
  ])
    await mocks.db.prepare(`DELETE FROM ${table}`).run();
  await store(fixture);
});
async function store(f: typeof fixture) {
  await mocks.db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,?,?,?,1,0,?,?)')
    .bind(
      'alice',
      projectId,
      'Solana',
      f.mint,
      '{}',
      crypto.randomUUID(),
      new Date().toISOString(),
    )
    .run();
  await mocks.db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,0)')
    .bind('alice', 'Solana', f.wallet, 1)
    .run();
  const document = {
    ...unsignedPreparationSummary(f.order, f.simulation),
    balance: {
      source: 'fixture.test',
      observedAt: new Date().toISOString(),
      requestedRaw: f.order.inAmount,
      amountCovered: true,
    },
  };
  await mocks.db
    .prepare('INSERT INTO imported_swap_preparations VALUES(?,?,?,?,?,?,?,?)')
    .bind(
      preparationId,
      'alice',
      projectId,
      1,
      f.wallet,
      1,
      JSON.stringify(document),
      new Date().toISOString(),
    )
    .run();
}
const request = (
  transaction = fixture.order.preparation.transaction,
  extra = {},
) =>
  POST(
    new Request('http://localhost/api/imported-projects/signing-checks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extra },
      body: JSON.stringify({ preparationId, transaction }),
    }),
  );
it('checks exact owned native buy and sell packets without creating an approval or returning signing bytes', async () => {
  for (const side of ['Buy', 'Sell'] as const) {
    const f =
      side === 'Buy'
        ? fixture
        : await nativeWarmupFixture({ side, lookup: true, v2: true });
    if (side === 'Sell') {
      for (const table of [
        'imported_token_projects',
        'imported_swap_preparations',
        'workspace_wallets',
        'wallet_balance_gates',
      ])
        await mocks.db.prepare(`DELETE FROM ${table}`).run();
      await store(f);
      mocks.simulate.mockResolvedValue(f.simulation);
    }
    const response = await request(f.order.preparation.transaction);
    expect(response.status).toBe(200);
    const value = (await response.json()) as {
      checks: Record<string, unknown>;
    };
    expect(value.checks).toMatchObject({
      projectId,
      preparationId,
      projectRevision: 1,
      walletRevision: 1,
      wallet: f.wallet,
      side,
      sha256: f.order.preparation.sha256,
      networkFeeLamports: '5000',
      approvalCreated: false,
      executionAllowed: false,
    });
    expect(value.checks).not.toHaveProperty('transaction');
    expect(value.checks).not.toHaveProperty('id');
    expect(mocks.simulate.mock.calls.at(-1)?.[3]).toBe(true);
  }
});
it('rejects authentication, origin, foreign ownership, wrong packet and stale context before provider reads', async () => {
  mocks.user = null;
  expect((await request()).status).toBe(401);
  mocks.user = { userId: 'alice' };
  expect(
    (await request(undefined, { origin: 'https://other.test' })).status,
  ).toBe(403);
  mocks.user = { userId: 'bob' };
  expect((await request()).status).toBe(409);
  mocks.user = { userId: 'alice' };
  expect((await request('invalid')).status).toBe(502);
  expect((await request(fixture.signed.transaction)).status).toBe(502);
  await mocks.db.prepare('UPDATE workspace_wallets SET revision=2').run();
  expect((await request()).status).toBe(409);
  expect(mocks.simulate).not.toHaveBeenCalled();
});
it('returns the remaining shared read wait and rejects concurrent project changes and expired blockhashes', async () => {
  await mocks.db
    .prepare('INSERT INTO wallet_balance_gates VALUES(?,?)')
    .bind('alice', Date.now() + 10000)
    .run();
  const gated = await request();
  expect(gated.status).toBe(429);
  expect(
    ((await gated.json()) as { reviewWaitMs: number }).reviewWaitMs,
  ).toBeGreaterThan(0);
  expect(mocks.simulate).not.toHaveBeenCalled();
  await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
  mocks.simulate.mockImplementationOnce(async () => {
    await mocks.db
      .prepare('UPDATE imported_token_projects SET archived=1')
      .run();
    return fixture.simulation;
  });
  expect((await request()).status).toBe(409);
  await mocks.db.prepare('UPDATE imported_token_projects SET archived=0').run();
  await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
  mocks.simulate.mockRejectedValueOnce(new SwapBlockhashExpiredError());
  const expired = await request();
  expect(expired.status).toBe(409);
  expect(await expired.json()).toMatchObject({
    error: expect.stringContaining('blockhash expired'),
  });
});
