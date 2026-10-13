import { afterAll, beforeAll, beforeEach, it, expect, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { counterBuyFixture } from '@/test/counter-buy-fixture';
import { initialCounterLedger } from '@/lib/counter-trade';
import type { CounterPlan } from '@/lib/counter-trade-store';
const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
  quote: vi.fn(),
  env: { JUPITER_API_KEY: 'fixture-key' },
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('cloudflare:workers', () => ({ env: mocks.env }));
vi.mock('@/lib/counter-buy-quote', () => ({
  quoteCounterBuyProposal: mocks.quote,
}));
import { POST } from './route';
let mf: Miniflare, db: D1Database, plan: CounterPlan;
let input: {
  projectId: string;
  projectRevision: number;
  planId: string;
  planRevision: number;
  decisionIdentity: string;
  maximumSolAmount: string;
};
const request = (patch: object = {}, origin = 'https://bundle.test') =>
  POST(
    new Request('https://bundle.test/api/imported-projects/counter-quotes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ ...input, ...patch }),
    }),
  );
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'counter-quote-api-fixture',
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
          env: { DB: { type: 'd1', id: 'counter-quote-test-only' } },
        },
      },
    ],
  });
  db = await mf.getD1Database('DB', 'counter-quote-api-fixture');
  mocks.db = db;
  for (const sql of [
    'CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,revision INTEGER,archived INTEGER,chain TEXT,address TEXT,document TEXT,PRIMARY KEY(owner_id,id))',
    'CREATE TABLE imported_pool_trades(owner_id TEXT,project_id TEXT,document TEXT)',
    'CREATE TABLE imported_token_project_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
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
    .filter((s) => s.trim()))
    await db.prepare(statement).run();
});
afterAll(async () => {
  await mf.dispose();
});
beforeEach(async () => {
  mocks.user = { userId: 'alice' };
  mocks.env.JUPITER_API_KEY = 'fixture-key';
  mocks.quote.mockReset();
  for (const table of [
    'counter_trade_plans',
    'imported_token_projects',
    'imported_token_project_gates',
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
  const f = counterBuyFixture();
  plan = f.plan;
  plan.projectDocument = JSON.stringify({
    token: {
      chain: 'Solana',
      address: plan.ledger.scope.mint,
      decimals: plan.ledger.scope.decimals,
    },
  });
  const empty = {
    ...plan,
    revision: 1,
    ledger: initialCounterLedger(plan.rules, plan.ledger.scope),
  };
  await db
    .prepare("INSERT INTO counter_trade_plans VALUES(?,?,?,1,'active',?)")
    .bind('alice', plan.projectId, plan.id, JSON.stringify(empty))
    .run();
  await db
    .prepare('UPDATE counter_trade_plans SET revision=2,document=?')
    .bind(JSON.stringify(plan))
    .run();
  await db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,1,0,?,?,?)')
    .bind(
      'alice',
      plan.projectId,
      'Solana',
      plan.ledger.scope.mint,
      plan.projectDocument,
    )
    .run();
  input = {
    projectId: plan.projectId,
    projectRevision: 1,
    planId: plan.id,
    planRevision: 2,
    decisionIdentity: f.identity,
    maximumSolAmount: '0.000001005',
  };
  mocks.quote.mockImplementation(async () => ({
    executionAllowed: false,
    expiresAt: new Date(Date.now() + 30000).toISOString(),
    outputTargetRaw: f.response.outAmount,
    maximumSolInputRaw: '1005',
  }));
});
it('prices only the saved owned proposal using exact reviewed SOL atoms without consuming history', async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(mocks.quote).toHaveBeenCalledOnce();
  expect(mocks.quote.mock.calls[0][2]).toBe('1005');
  expect(
    ((await response.json()) as { executionAllowed: boolean }).executionAllowed,
  ).toBe(false);
  const row = await db
    .prepare('SELECT revision,document FROM counter_trade_plans')
    .first<{ revision: number; document: string }>();
  expect(row?.revision).toBe(2);
  expect(row?.document).toBe(JSON.stringify(plan));
});
it('rejects unauthorized, foreign, injected and stale requests before provider reads', async () => {
  mocks.user = null;
  expect((await request()).status).toBe(401);
  mocks.user = { userId: 'bob' };
  expect((await request()).status).toBe(404);
  mocks.user = { userId: 'alice' };
  expect((await request({}, 'https://other.test')).status).toBe(403);
  expect((await request({ targetRaw: '999' })).status).toBe(400);
  expect((await request({ planRevision: 1 })).status).toBe(409);
  expect((await request({ decisionIdentity: 'missing' })).status).toBe(409);
  expect((await request({ maximumSolAmount: '0' })).status).toBe(400);
  expect(mocks.quote).not.toHaveBeenCalled();
});
it('blocks paused, archived and precision-mismatched contexts without provider access', async () => {
  await db.prepare('UPDATE imported_token_projects SET archived=1').run();
  expect((await request()).status).toBe(409);
  await db
    .prepare('UPDATE imported_token_projects SET archived=0,document=?')
    .bind(
      JSON.stringify({
        token: {
          chain: 'Solana',
          address: plan.ledger.scope.mint,
          decimals: 5,
        },
      }),
    )
    .run();
  expect((await request()).status).toBe(409);
  await db
    .prepare('UPDATE imported_token_projects SET document=?')
    .bind(plan.projectDocument)
    .run();
  const paused = { ...plan, revision: 3, state: 'paused' };
  await db
    .prepare(
      "UPDATE counter_trade_plans SET revision=3,state='paused',document=?",
    )
    .bind(JSON.stringify(paused))
    .run();
  expect((await request({ planRevision: 3 })).status).toBe(409);
  expect(mocks.quote).not.toHaveBeenCalled();
});
it('enforces the shared quote rate gate', async () => {
  expect((await request()).status).toBe(200);
  expect((await request()).status).toBe(429);
  expect(mocks.quote).toHaveBeenCalledOnce();
});
it.each(['project', 'plan'])(
  'withholds a preview when %s context changes during the provider read',
  async (changed) => {
    mocks.quote.mockImplementationOnce(async () => {
      if (changed === 'project')
        await db
          .prepare("UPDATE imported_token_projects SET document=document||' '")
          .run();
      else
        await db
          .prepare(
            "UPDATE counter_trade_plans SET revision=3,state='paused',document=?",
          )
          .bind(JSON.stringify({ ...plan, revision: 3, state: 'paused' }))
          .run();
      return {
        executionAllowed: false,
        expiresAt: new Date(Date.now() + 30000).toISOString(),
      };
    });
    expect((await request()).status).toBe(409);
  },
);
it('rejects expired previews and sanitizes unexpected provider failures', async () => {
  mocks.quote.mockResolvedValueOnce({ expiresAt: '2000-01-01T00:00:00.000Z' });
  expect((await request()).status).toBe(409);
  await db.prepare('DELETE FROM imported_token_project_gates').run();
  mocks.quote.mockRejectedValueOnce(new Error('PRIVATE-PROVIDER-DETAIL'));
  const response = await request();
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain(
    'PRIVATE-PROVIDER',
  );
});
