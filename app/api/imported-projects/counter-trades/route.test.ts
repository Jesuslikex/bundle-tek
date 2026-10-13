import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import bs58 from 'bs58';
import { directMovementFixture } from '../../../../test/direct-movement-fixture';
import { classifyWalletMovement } from '@/lib/wallet-movement-classification';
import type { PoolTradeMovement } from '@/lib/pool-trade-movement';
const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
  observe: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/pool-trade-movement-server', () => ({
  observePoolTradeMovement: mocks.observe,
}));
import { GET, POST } from './route';
import { decodeCounterPlan } from '@/lib/counter-trade-store';
async function planBody(response: Response) {
  const value = (await response.json()) as {
    plan: unknown;
    executionAllowed: unknown;
    replayed?: unknown;
  };
  expect(value.executionAllowed).toBe(false);
  return { ...value, plan: decodeCounterPlan(value.plan) };
}
let mf: Miniflare,
  db: D1Database,
  movement: PoolTradeMovement,
  selection: Record<string, unknown>,
  projectDoc: string;
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owned = bs58.encode(new Uint8Array(32).fill(44));
const rules = {
  format: 'counter-evaluator-v1',
  responseSide: 'Sell',
  replicationPercent: '20',
  trigger: { kind: 'rate', percent: '100' },
  minimumResponseTokenRaw: '500',
  ignoredWallets: [],
};
const post = (body: unknown) =>
  POST(
    new Request('https://bundle.test/api/imported-projects/counter-trades', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://bundle.test',
      },
      body: JSON.stringify(body),
    }),
  );
const get = () =>
  GET(
    new Request(
      `https://bundle.test/api/imported-projects/counter-trades?projectId=${id(1)}&id=${id(2)}`,
    ),
  );
const create = () =>
  post({
    action: 'create',
    id: id(2),
    projectId: id(1),
    projectRevision: 1,
    rules,
  });
const evaluate = (revision = 1) =>
  post({
    action: 'evaluate',
    id: id(2),
    projectId: id(1),
    revision,
    selection,
  });
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'counter-api-fixture',
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
          env: { DB: { type: 'd1', id: 'counter-api-test-only' } },
        },
      },
    ],
  });
  db = await mf.getD1Database('DB', 'counter-api-fixture');
  mocks.db = db;
  for (const sql of [
    'CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,revision INTEGER,archived INTEGER,chain TEXT,address TEXT,document TEXT,PRIMARY KEY(owner_id,id))',
    'CREATE TABLE imported_pool_trades(owner_id TEXT,project_id TEXT,document TEXT,PRIMARY KEY(owner_id,project_id))',
    'CREATE TABLE wallet_ownership_proofs(owner_id TEXT,chain TEXT,address TEXT)',
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT)',
    'CREATE TABLE wallet_balance_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
  ])
    await db.prepare(sql).run();
  const sql = await readFile(
    new URL(
      '../../../../drizzle/0076_flaky_crusher_hogan.sql',
      import.meta.url,
    ),
    'utf8',
  );
  for (const statement of sql
    .split('--> statement-breakpoint')
    .filter((x) => x.trim()))
    await db.prepare(statement).run();
});
afterAll(async () => {
  await mf.dispose();
});
beforeEach(async () => {
  mocks.user = { userId: 'alice' };
  mocks.observe.mockReset();
  for (const table of [
    'counter_trade_plans',
    'imported_pool_trades',
    'imported_token_projects',
    'wallet_ownership_proofs',
    'workspace_wallets',
    'wallet_balance_gates',
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
  const tx = directMovementFixture(0, 0),
    token = tx.tokenChanges[1],
    time = new Date().toISOString(),
    signature = bs58.encode(new Uint8Array(64).fill(1));
  projectDoc = JSON.stringify({
    token: { chain: 'Solana', address: token.mint, decimals: 6 },
  });
  await db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,1,0,?,?,?)')
    .bind('alice', id(1), 'Solana', token.mint, projectDoc)
    .run();
  await db
    .prepare('INSERT INTO wallet_ownership_proofs VALUES(?,?,?)')
    .bind('alice', 'Solana', owned)
    .run();
  selection = {
    id: id(1),
    revision: 1,
    pool: tx.tokenChanges[0].mint,
    tradeId: 'trade-1',
    tapeObservedAt: time,
  };
  await db
    .prepare('INSERT INTO imported_pool_trades VALUES(?,?,?)')
    .bind(
      'alice',
      id(1),
      JSON.stringify([
        {
          pool: selection.pool,
          chain: 'Solana',
          address: token.mint,
          projectRevision: 1,
          observedAt: time,
          trades: [
            {
              id: 'trade-1',
              transaction: signature,
              sender: tx.address,
              block: 100,
              side: 'Buy',
              timestamp: time,
            },
          ],
        },
      ]),
    )
    .run();
  movement = {
    format: 'pool-trade-movement-v1',
    executionAllowed: false,
    projectId: id(1),
    revision: 1,
    pool: String(selection.pool),
    mint: token.mint,
    wallet: tx.address,
    signature,
    tradeId: 'trade-1',
    tapeObservedAt: time,
    slot: 100,
    providerBlock: 100,
    blockAgrees: true,
    blockTime: Math.floor(Date.now() / 1000),
    commitment: 'confirmed',
    failed: false,
    walletSigner: true,
    providerSide: 'Buy',
    sideAgrees: true,
    tokenChange: {
      beforeRaw: token.beforeRaw,
      afterRaw: token.afterRaw,
      changeRaw: token.changeRaw,
      decimals: 6,
    },
    classification: classifyWalletMovement(tx, token.mint),
    observedAt: time,
    source: 'rpc.fixture.test',
  };
  mocks.observe.mockImplementation(async () => ({
    ...movement,
    observedAt: new Date().toISOString(),
    blockTime: Math.floor(Date.now() / 1000),
  }));
});
it('creates owner-scoped plans with controlled-wallet exclusions and recovers a lost evaluation response without provider replay', async () => {
  const created = await create();
  expect(created.status).toBe(200);
  const p = (await planBody(created)).plan;
  expect(p.rules.ignoredWallets).toEqual([owned]);
  expect((await create()).status).toBe(200);
  const first = await evaluate();
  expect(first.status).toBe(200);
  const body = await planBody(first);
  expect(body.plan.ledger.queuedTokenRaw).toBe('200');
  expect(body.executionAllowed).toBe(false);
  expect((await get()).status).toBe(200);
  const replay = await evaluate();
  expect(replay.status).toBe(200);
  const recovered = await planBody(replay);
  expect(recovered.replayed).toBe(true);
  expect(recovered.plan.ledger.decisions).toHaveLength(1);
  expect(recovered.plan.ledger.queuedTokenRaw).toBe('200');
  expect(mocks.observe).toHaveBeenCalledTimes(1);
  mocks.user = { userId: 'bob' };
  expect((await get()).status).toBe(404);
  expect((await evaluate()).status).toBe(404);
});
it('blocks new evaluation before providers on pause, end, stale revision and owned-wallet drift', async () => {
  await create();
  expect(
    (
      await post({
        action: 'control',
        projectId: id(1),
        id: id(2),
        revision: 1,
        state: 'paused',
      })
    ).status,
  ).toBe(200);
  expect((await evaluate()).status).toBe(409);
  expect(mocks.observe).not.toHaveBeenCalled();
  expect(
    (
      await post({
        action: 'control',
        projectId: id(1),
        id: id(2),
        revision: 2,
        state: 'active',
      })
    ).status,
  ).toBe(200);
  expect((await evaluate(1)).status).toBe(409);
  await db
    .prepare('INSERT INTO wallet_ownership_proofs VALUES(?,?,?)')
    .bind('alice', 'Solana', bs58.encode(new Uint8Array(32).fill(45)))
    .run();
  expect((await evaluate(3)).status).toBe(409);
  expect(mocks.observe).not.toHaveBeenCalled();
  expect(
    (
      await post({
        action: 'control',
        projectId: id(1),
        id: id(2),
        revision: 3,
        state: 'ended',
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await post({
        action: 'control',
        projectId: id(1),
        id: id(2),
        revision: 4,
        state: 'active',
      })
    ).status,
  ).toBe(409);
});
it('atomically withholds decisions when tape, project, control or owned-wallet context changes during a read', async () => {
  for (const changed of ['tape', 'project', 'control', 'wallet']) {
    const planId = id(
      { tape: 2, project: 3, control: 4, wallet: 5 }[changed as 'tape'],
    );
    const made = await post({
      action: 'create',
      id: planId,
      projectId: id(1),
      projectRevision: 1,
      rules,
    });
    expect(made.status).toBe(200);
    await db.prepare('DELETE FROM wallet_balance_gates').run();
    mocks.observe.mockImplementationOnce(async () => {
      if (changed === 'tape')
        await db
          .prepare("UPDATE imported_pool_trades SET document=document||' '")
          .run();
      if (changed === 'project')
        await db
          .prepare("UPDATE imported_token_projects SET document=document||' '")
          .run();
      if (changed === 'control')
        await post({
          action: 'control',
          projectId: id(1),
          id: planId,
          revision: 1,
          state: 'paused',
        });
      if (changed === 'wallet')
        await db
          .prepare('INSERT INTO wallet_ownership_proofs VALUES(?,?,?)')
          .bind('alice', 'Solana', bs58.encode(new Uint8Array(32).fill(46)))
          .run();
      return {
        ...movement,
        observedAt: new Date().toISOString(),
        blockTime: Math.floor(Date.now() / 1000),
      };
    });
    const response = await post({
      action: 'evaluate',
      id: planId,
      projectId: id(1),
      revision: 1,
      selection,
    });
    expect(response.status).toBe(409);
    const stored = await db
      .prepare('SELECT document FROM counter_trade_plans WHERE id=?')
      .bind(planId)
      .first<{ document: string }>();
    expect(JSON.parse(stored!.document).ledger.decisions).toEqual([]);
    await db
      .prepare('UPDATE imported_token_projects SET document=?')
      .bind(projectDoc)
      .run();
    const tape = await db
      .prepare('SELECT document FROM imported_pool_trades')
      .first<{ document: string }>();
    await db
      .prepare('UPDATE imported_pool_trades SET document=?')
      .bind(tape!.document.trim())
      .run();
  }
});
it('rejects missing/old chain times and substituted source identity without recording a proposal', async () => {
  await create();
  for (const patch of [
    { blockTime: null },
    { blockTime: Math.floor(Date.now() / 1000) - 301 },
    { mint: owned },
  ]) {
    await db.prepare('DELETE FROM wallet_balance_gates').run();
    mocks.observe.mockResolvedValueOnce({ ...movement, ...patch });
    expect([409, 503]).toContain((await evaluate()).status);
    const p = (await planBody(await get())).plan;
    expect(p.ledger.decisions).toEqual([]);
  }
});
it('recovers an ineligible block-mismatch decision without rerolling or another provider read', async () => {
  await create();
  mocks.observe.mockImplementationOnce(async () => ({
    ...movement,
    slot: 101,
    blockAgrees: false,
    observedAt: new Date().toISOString(),
    blockTime: Math.floor(Date.now() / 1000),
  }));
  const first = await evaluate();
  expect(first.status).toBe(200);
  expect((await planBody(first)).plan.ledger.decisions[0].outcome).toBe(
    'ineligible-evidence',
  );
  const repeated = await evaluate();
  expect(repeated.status).toBe(200);
  expect((await planBody(repeated)).replayed).toBe(true);
  expect(mocks.observe).toHaveBeenCalledTimes(1);
});
it('allows readable history and ending after archival but never resume/evaluation', async () => {
  await create();
  await db.prepare('UPDATE imported_token_projects SET archived=1').run();
  expect((await get()).status).toBe(200);
  expect((await evaluate()).status).toBe(409);
  expect(
    (
      await post({
        action: 'control',
        projectId: id(1),
        id: id(2),
        revision: 1,
        state: 'ended',
      })
    ).status,
  ).toBe(200);
  expect(mocks.observe).not.toHaveBeenCalled();
});
it('retains one winning decision under concurrent requests and rejects database rewrites of rules or decision history', async () => {
  await create();
  const responses = await Promise.all([evaluate(), evaluate()]);
  expect(responses.some((r) => r.status === 200)).toBe(true);
  expect(responses.every((r) => [200, 409, 429].includes(r.status))).toBe(true);
  const p = (await planBody(await get())).plan;
  expect(p.ledger.decisions).toHaveLength(1);
  expect(p.ledger.queuedTokenRaw).toBe('200');
  expect(mocks.observe).toHaveBeenCalledTimes(1);
  const forged = structuredClone(p);
  forged.revision++;
  forged.ledger.decisions[0].contributionTokenRaw = '999';
  await expect(
    db
      .prepare(
        'UPDATE counter_trade_plans SET revision=?,document=? WHERE id=?',
      )
      .bind(forged.revision, JSON.stringify(forged), id(2))
      .run(),
  ).rejects.toThrow();
  forged.ledger = p.ledger;
  forged.rules.replicationPercent = '99';
  await expect(
    db
      .prepare(
        'UPDATE counter_trade_plans SET revision=?,document=? WHERE id=?',
      )
      .bind(forged.revision, JSON.stringify(forged), id(2))
      .run(),
  ).rejects.toThrow();
  const retained = (await planBody(await get())).plan;
  expect(retained.rules.replicationPercent).toBe('20');
  expect(retained.ledger.queuedTokenRaw).toBe('200');
});
it('rejects unauthenticated, cross-origin, malformed and client-forged classifications before provider work', async () => {
  mocks.user = null;
  expect((await create()).status).toBe(401);
  mocks.user = { userId: 'alice' };
  expect(
    (
      await POST(
        new Request('https://bundle.test/x', {
          method: 'POST',
          headers: {
            origin: 'https://other.test',
            'content-type': 'application/json',
          },
          body: '{}',
        }),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await post({
        action: 'evaluate',
        id: id(2),
        projectId: id(1),
        revision: 1,
        selection,
        movement,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await post({
        action: 'create',
        id: id(2),
        projectId: id(1),
        projectRevision: 1,
        rules: { ...rules, replicationPercent: '-1' },
      })
    ).status,
  ).toBe(400);
  expect(mocks.observe).not.toHaveBeenCalled();
});

it('evaluates watched external buyers while excluding verified and selected trading wallets', async () => {
  await db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?)')
    .bind('alice', 'Solana', movement.wallet)
    .run();
  const selectedWallet = bs58.encode(new Uint8Array(32).fill(47));
  projectDoc = JSON.stringify({
    ...JSON.parse(projectDoc),
    tradeSettings: { wallet: selectedWallet },
  });
  await db
    .prepare('UPDATE imported_token_projects SET document=?')
    .bind(projectDoc)
    .run();
  const made = await planBody(await create());
  expect(made.plan.rules.ignoredWallets).toContain(owned);
  expect(made.plan.rules.ignoredWallets).toContain(selectedWallet);
  expect(made.plan.rules.ignoredWallets).not.toContain(movement.wallet);
  const response = await evaluate();
  expect(response.status).toBe(200);
  const saved = (await planBody(response)).plan;
  expect(saved.ledger.decisions[0].outcome).not.toBe('excluded-wallet');
  expect(saved.ledger.queuedTokenRaw).toBe('200');
});
it('uses database time to reject stale evidence even when the application clock lags', async () => {
  const plan = (await planBody(await create())).plan;
  const actual = Date.now();
  plan.createdAt = plan.updatedAt = new Date(actual - 600_000).toISOString();
  await db.prepare('DELETE FROM counter_trade_plans').run();
  await db
    .prepare("INSERT INTO counter_trade_plans VALUES(?,?,?,1,'active',?)")
    .bind('alice', id(1), id(2), JSON.stringify(plan))
    .run();
  mocks.observe.mockResolvedValueOnce({
    ...movement,
    observedAt: new Date(actual - 301_000).toISOString(),
    blockTime: Math.floor((actual - 301_000) / 1000),
  });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(actual - 300_000);
  try {
    const response = await evaluate();
    expect(response.status).toBe(409);
    expect(mocks.observe).toHaveBeenCalledTimes(1);
    expect((await planBody(await get())).plan.ledger.decisions).toEqual([]);
  } finally {
    clock.mockRestore();
  }
});
