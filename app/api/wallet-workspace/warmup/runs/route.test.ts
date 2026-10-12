import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import type { WarmupHistoryRun } from '@/lib/warmup-history-run';
const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
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
import { GET, POST } from './route';
import { GET as activityGET } from './activity/route';
import type { WarmupRunActivityEvent } from '@/lib/warmup-history-run-events';
import { GET as eventsGET } from './events/route';
import type { WarmupHistoryRunEvent } from '@/lib/warmup-history-run-events';
let mf: Miniflare;
const planId = '00000000-0000-4000-8000-000000000001',
  wallet = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
const post = (action: string, id = planId, revision = 1, headers = {}) =>
  POST(
    new Request('http://localhost/api/wallet-workspace/warmup/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ action, id, revision }),
    }),
  );
const list = () =>
  GET(
    new Request(
      `http://localhost/api/wallet-workspace/warmup/runs?planId=${planId}`,
    ),
  );
const run = async (response: Response) =>
  ((await response.json()) as { run: WarmupHistoryRun }).run;
const clearGate = () =>
  mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'history-runs-test',
          type: 'worker',
          compatibilityDate: '2026-09-01',
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': {
                type: 'esm',
                contents:
                  'export default {fetch(){return new Response("test")}}',
              },
            },
          },
          env: { DB: { type: 'd1', id: 'history-runs-test-only' } },
        },
      },
    ],
  });
  mocks.db = (await mf.getD1Database(
    'DB',
    'history-runs-test',
  )) as unknown as D1Database;
  for (const file of [
    '0021_wallet_warmup_plans.sql',
    '0028_warmup_history_runs.sql',
    '0029_warmup_history_run_events.sql',
  ])
    for (const sql of readFileSync(
      new URL(`../../../../../drizzle/${file}`, import.meta.url),
      'utf8',
    )
      .split('--> statement-breakpoint')
      .filter((s) => s.trim()))
      await mocks.db.prepare(sql).run();
  await mocks.db
    .prepare(
      'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER,PRIMARY KEY(owner_id,chain,address))',
    )
    .run();
  await mocks.db
    .prepare(
      'CREATE TABLE wallet_balance_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
    )
    .run();
});
beforeEach(async () => {
  for (const table of [
    'warmup_history_run_events',
    'warmup_history_runs',
    'wallet_warmup_plans',
    'workspace_wallets',
    'wallet_balance_gates',
  ])
    await mocks.db.prepare(`DELETE FROM ${table}`).run();
  mocks.user = { userId: 'alice' };
  mocks.observe.mockReset().mockResolvedValue({
    chain: 'Solana',
    address: wallet,
    source: 'rpc.test',
    observedAt: new Date().toISOString(),
    nativeBalance: '0.01',
    currency: 'SOL',
    block: '100',
    outgoingTransactions: null,
    sampleCount: 2,
    successfulSampleCount: 1,
    oldestObservedAt: null,
    latestObservedAt: null,
    coverage: 'Latest 50 finalized signature records only.',
  });
  await mocks.db
    .prepare('INSERT INTO wallet_warmup_plans VALUES (?,?,?,1,0,?)')
    .bind(
      'alice',
      planId,
      JSON.stringify({
        chain: 'Solana',
        walletRevisions: [{ address: wallet, revision: 1 }],
      }),
      new Date().toISOString(),
    )
    .run();
  await mocks.db
    .prepare('INSERT INTO workspace_wallets VALUES (?,?,?,?,0)')
    .bind('alice', 'Solana', wallet, 1)
    .run();
});
afterAll(async () => {
  await mf.dispose();
});
it('retains a cancelled in-flight request as an interruption rather than a provider outage', async () => {
  const saved = await run(await post('create'));
  const controller = new AbortController();
  mocks.observe.mockImplementationOnce(async () => {
    controller.abort();
    throw new Error('cancelled');
  });
  const result = await run(
    await POST(
      new Request('http://localhost/api/wallet-workspace/warmup/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          action: 'advance',
          id: saved.id,
          revision: saved.revision,
        }),
      }),
    ),
  );
  expect(result.document.results[0]).toEqual({
    address: wallet,
    error: 'History check interrupted. No readiness conclusion.',
  });
  expect(result.state).toBe('completed');
  expect(result.document.results[0].observation).toBeUndefined();
});
it('a late expired-lease result cannot overwrite a recovered run', async () => {
  const saved = await run(await post('create'));
  let release!: () => void, reached!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  mocks.observe.mockImplementationOnce(async () => {
    reached();
    await waiting;
    return { address: wallet, chain: 'Solana', sampleCount: 99 };
  });
  const first = post('advance', saved.id, saved.revision);
  await started;
  await mocks.db
    .prepare('UPDATE warmup_history_runs SET lease_until=? WHERE id=?')
    .bind(Date.now() - 1, saved.id)
    .run();
  await clearGate();
  const recovered = await run(
    await post('advance', saved.id, saved.revision + 1),
  );
  expect(recovered.document.results[0].observation?.sampleCount).toBe(2);
  release();
  expect((await first).status).toBe(409);
  const rows = (await (await list()).json()) as { runs: WarmupHistoryRun[] };
  expect(rows.runs[0].state).toBe('completed');
  expect(rows.runs[0].document.results[0].observation?.sampleCount).toBe(2);
});
it('persists owned run transitions and retains terminal results across reload', async () => {
  const created = await post('create');
  expect(created.status).toBe(200);
  let saved = await run(created);
  expect(saved).toMatchObject({
    state: 'planned',
    revision: 1,
    planRevision: 1,
  });
  expect(mocks.observe).not.toHaveBeenCalled();
  expect((await post('create')).status).toBe(409);
  saved = await run(await post('pause', saved.id, saved.revision));
  expect(saved.state).toBe('paused');
  expect((await post('advance', saved.id, saved.revision)).status).toBe(409);
  saved = await run(await post('resume', saved.id, saved.revision));
  saved = await run(await post('advance', saved.id, saved.revision));
  expect(saved.state).toBe('completed');
  expect(saved.document.results[0].observation?.sampleCount).toBe(2);
  expect((await post('resume', saved.id, saved.revision)).status).toBe(409);
  expect((await list()).status).toBe(200);
  mocks.user = { userId: 'bob' };
  expect((await list()).status).toBe(404);
  expect((await post('cancel', saved.id, saved.revision)).status).toBe(409);
});
it('rejects authentication, origin, media type and stale plan/wallet revisions before reads', async () => {
  mocks.user = null;
  expect((await post('create')).status).toBe(401);
  expect((await list()).status).toBe(401);
  mocks.user = { userId: 'alice' };
  expect(
    (await post('create', planId, 1, { origin: 'https://other.test' })).status,
  ).toBe(403);
  expect(
    (await post('create', planId, 1, { 'content-type': 'text/plain' })).status,
  ).toBe(415);
  expect((await post('create', 'bad')).status).toBe(400);
  expect((await post('create', planId, 2)).status).toBe(409);
  const saved = await run(await post('create'));
  await mocks.db
    .prepare("UPDATE workspace_wallets SET revision=2 WHERE owner_id='alice'")
    .run();
  expect((await post('advance', saved.id, saved.revision)).status).toBe(409);
  expect(mocks.observe).not.toHaveBeenCalled();
});
it.each(['pause', 'cancel'])(
  '%s during an in-flight RPC discards the observation and preserves the control state',
  async (action) => {
    const saved = await run(await post('create'));
    mocks.observe.mockImplementationOnce(async () => {
      const row = await mocks.db
        .prepare('SELECT revision FROM warmup_history_runs WHERE id=?')
        .bind(saved.id)
        .first<{ revision: number }>();
      expect((await post(action, saved.id, row!.revision)).status).toBe(200);
      return { address: wallet, chain: 'Solana' };
    });
    expect((await post('advance', saved.id, saved.revision)).status).toBe(409);
    const rows = (await (await list()).json()) as { runs: WarmupHistoryRun[] };
    expect(rows.runs[0]).toMatchObject({
      state: action === 'pause' ? 'paused' : 'cancelled',
      document: { results: [] },
    });
  },
);
it('wallet edits during RPC pause the run without admitting stale results', async () => {
  const saved = await run(await post('create'));
  mocks.observe.mockImplementationOnce(async () => {
    await mocks.db
      .prepare("UPDATE workspace_wallets SET revision=2 WHERE owner_id='alice'")
      .run();
    return { address: wallet, chain: 'Solana' };
  });
  expect((await post('advance', saved.id, saved.revision)).status).toBe(409);
  const rows = (await (await list()).json()) as { runs: WarmupHistoryRun[] };
  expect(rows.runs[0].state).toBe('paused');
  expect(rows.runs[0].document.results).toEqual([]);
  expect((await post('resume', saved.id, rows.runs[0].revision)).status).toBe(
    409,
  );
  expect((await post('cancel', saved.id, rows.runs[0].revision)).status).toBe(
    200,
  );
});
it('recovers expired leases and records provider failures explicitly', async () => {
  const saved = await run(await post('create'));
  await mocks.db
    .prepare(
      "UPDATE warmup_history_runs SET state='running',revision=2,lease_nonce='old',lease_until=? WHERE id=?",
    )
    .bind(Date.now() + 45000, saved.id)
    .run();
  expect((await post('advance', saved.id, 2)).status).toBe(409);
  await mocks.db
    .prepare('UPDATE warmup_history_runs SET lease_until=? WHERE id=?')
    .bind(Date.now() - 1, saved.id)
    .run();
  mocks.observe.mockRejectedValueOnce(new Error('private provider details'));
  const recovered = await run(await post('advance', saved.id, 2));
  expect(recovered.state).toBe('completed');
  expect(recovered.document.results[0].error).toContain(
    'No readiness conclusion',
  );
  expect(JSON.stringify(recovered)).not.toContain('private provider');
  expect((await post('advance', saved.id, recovered.revision)).status).toBe(
    409,
  );
  await clearGate();
  expect((await post('create')).status).toBe(200);
});

it('retains partial progress across steps and applies the shared read throttle', async () => {
  const second = '8phnoC6V8nwYnNUwobNBoWzWAmyP1nj9GyYZaMbU8z4';
  await mocks.db
    .prepare('UPDATE wallet_warmup_plans SET document=? WHERE id=?')
    .bind(
      JSON.stringify({
        chain: 'Solana',
        walletRevisions: [
          { address: wallet, revision: 1 },
          { address: second, revision: 1 },
        ],
      }),
      planId,
    )
    .run();
  await mocks.db
    .prepare('INSERT INTO workspace_wallets VALUES (?,?,?,?,0)')
    .bind('alice', 'Solana', second, 1)
    .run();
  let saved = await run(await post('create'));
  saved = await run(await post('advance', saved.id, saved.revision));
  expect(saved.state).toBe('planned');
  expect(saved.document.results).toHaveLength(1);
  expect((await post('advance', saved.id, saved.revision)).status).toBe(429);
  await clearGate();
  mocks.observe.mockResolvedValueOnce({ address: second, chain: 'Solana' });
  saved = await run(await post('advance', saved.id, saved.revision));
  expect(saved.state).toBe('completed');
  expect(saved.document.results.map((r) => r.address)).toEqual([
    wallet,
    second,
  ]);
  await mocks.db
    .prepare('UPDATE wallet_warmup_plans SET archived=1,revision=2 WHERE id=?')
    .bind(planId)
    .run();
  expect((await list()).status).toBe(200);
  expect((await post('create', planId, 2)).status).toBe(409);
});

it('records every admitted transition atomically with its wallet observation', async () => {
  let saved = await run(await post('create'));
  saved = await run(await post('pause', saved.id, saved.revision));
  saved = await run(await post('resume', saved.id, saved.revision));
  saved = await run(await post('advance', saved.id, saved.revision));
  const response = await eventsGET(
    new Request(
      `http://localhost/api/wallet-workspace/warmup/runs/events?id=${saved.id}`,
    ),
  );
  expect(response.status).toBe(200);
  const data = (await response.json()) as { events: WarmupHistoryRunEvent[] };
  expect(data.events.map((e) => e.type)).toEqual([
    'run.read_completed',
    'run.read_started',
    'run.resume',
    'run.pause',
    'run.created',
  ]);
  expect(data.events[0]).toMatchObject({
    revision: 5,
    state: 'completed',
    completedCount: 1,
    errorCount: 0,
    walletAddress: wallet,
    result: { observation: { sampleCount: 2 } },
  });
  expect(data.events[1].walletAddress).toBe(wallet);
  expect(data.events[1].result).toBeNull();
  const before = JSON.stringify(data.events);
  expect((await post('pause', saved.id, saved.revision)).status).toBe(409);
  const again = await eventsGET(
    new Request(
      `http://localhost/api/wallet-workspace/warmup/runs/events?id=${saved.id}`,
    ),
  );
  expect(
    JSON.stringify(((await again.json()) as { events: unknown[] }).events),
  ).toBe(before);
  mocks.user = { userId: 'bob' };
  expect(
    (
      await eventsGET(
        new Request(
          `http://localhost/api/wallet-workspace/warmup/runs/events?id=${saved.id}`,
        ),
      )
    ).status,
  ).toBe(404);
});
it('event-storage failure rolls back the run mutation', async () => {
  const saved = await run(await post('create'));
  await mocks.db
    .prepare(
      "CREATE TRIGGER fail_run_event BEFORE INSERT ON warmup_history_run_events BEGIN SELECT RAISE(ABORT,'test event failure'); END;",
    )
    .run();
  try {
    expect((await post('pause', saved.id, saved.revision)).status).toBe(503);
    const current = await mocks.db
      .prepare('SELECT revision,state FROM warmup_history_runs WHERE id=?')
      .bind(saved.id)
      .first();
    expect(current).toMatchObject({ revision: 1, state: 'planned' });
    const count = await mocks.db
      .prepare(
        'SELECT COUNT(*) AS count FROM warmup_history_run_events WHERE run_id=?',
      )
      .bind(saved.id)
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
  } finally {
    await mocks.db.prepare('DROP TRIGGER fail_run_event').run();
  }
});
it('pages run events by revision without duplicates and rejects noncanonical cursors', async () => {
  let saved = await run(await post('create'));
  for (let i = 0; i < 22; i++)
    saved = await run(
      await post(i % 2 ? 'resume' : 'pause', saved.id, saved.revision),
    );
  const request = (before?: string) =>
    eventsGET(
      new Request(
        `http://localhost/api/wallet-workspace/warmup/runs/events?id=${saved.id}${before === undefined ? '' : `&before=${before}`}`,
      ),
    );
  const first = (await (await request()).json()) as {
    events: WarmupHistoryRunEvent[];
    nextBefore: number;
  };
  expect(first.events).toHaveLength(20);
  const second = (await (await request(String(first.nextBefore))).json()) as {
    events: WarmupHistoryRunEvent[];
    nextBefore: null;
  };
  expect(second.events).toHaveLength(3);
  expect(second.nextBefore).toBeNull();
  expect(
    new Set([...first.events, ...second.events].map((e) => e.revision)).size,
  ).toBe(23);
  for (const before of ['0', '01', '1.1', '1000000001', '-1'])
    expect((await request(before)).status).toBe(400);
}, 15000);

it('caps repeated controls while preserving cancellation and validates timeline access', async () => {
  const saved = await run(await post('create'));
  await mocks.db
    .prepare(
      "UPDATE warmup_history_runs SET revision=1000,last_event='run.snapshot' WHERE id=?",
    )
    .bind(saved.id)
    .run();
  expect((await post('pause', saved.id, 1000)).status).toBe(409);
  expect((await post('cancel', saved.id, 1000)).status).toBe(200);
  mocks.user = null;
  expect(
    (
      await eventsGET(
        new Request(
          `http://localhost/api/wallet-workspace/warmup/runs/events?id=${saved.id}`,
        ),
      )
    ).status,
  ).toBe(401);
  mocks.user = { userId: 'alice' };
  expect(
    (
      await eventsGET(
        new Request(
          'http://localhost/api/wallet-workspace/warmup/runs/events?id=bad',
        ),
      )
    ).status,
  ).toBe(400);
});

const activity = (cursor?: string) =>
  activityGET(
    new Request(
      `http://localhost/api/wallet-workspace/warmup/runs/activity${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`,
    ),
  );
it('reads owned run Activity across archived plans without RPC or private result/lease data', async () => {
  let saved = await run(await post('create'));
  saved = await run(await post('advance', saved.id, saved.revision));
  await mocks.db
    .prepare(
      "UPDATE wallet_warmup_plans SET archived=1,revision=2,document=json_set(document,'$.name','Renamed plan','$.chain','Other') WHERE owner_id='alice'",
    )
    .run();
  mocks.observe.mockClear();
  const response = await activity();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const data = (await response.json()) as {
    events: WarmupRunActivityEvent[];
    executionAllowed: boolean;
    nextCursor: null;
  };
  expect(data.executionAllowed).toBe(false);
  expect(data.nextCursor).toBeNull();
  expect(data.events.map((e) => e.type)).toEqual([
    'run.read_completed',
    'run.read_started',
    'run.created',
  ]);
  expect(data.events[0]).toMatchObject({
    name: 'Renamed plan',
    chain: 'Solana',
    planRevision: 1,
    walletCount: 1,
    completedCount: 1,
    errorCount: 0,
    walletAddress: wallet,
  });
  expect(JSON.stringify(data)).not.toMatch(/lease|nonce|result|rpc.test/);
  expect(mocks.observe).not.toHaveBeenCalled();
  mocks.user = { userId: 'bob' };
  expect(
    ((await (await activity()).json()) as { events: unknown[] }).events,
  ).toEqual([]);
  mocks.user = null;
  expect((await activity()).status).toBe(401);
});
it('pages Activity through tied timestamps and run ids with exact revision cursors', async () => {
  const saved = await run(await post('create'));
  const stamp = '2026-10-10T15:00:00.000Z';
  // Seed bounded retained-event fixtures directly to exercise all three sort keys.
  await mocks.db.prepare('DELETE FROM warmup_history_run_events').run();
  const otherId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  await mocks.db
    .prepare(`INSERT INTO warmup_history_runs(owner_id,id,plan_id,plan_revision,document,state,revision,created_at,updated_at,last_event)
    SELECT owner_id,?,plan_id,plan_revision,document,'cancelled',1,?,?, 'run.cancel' FROM warmup_history_runs WHERE id=?`)
    .bind(otherId, stamp, stamp, saved.id)
    .run();
  const statements = Array.from({ length: 52 }, (_, i) =>
    mocks.db
      .prepare(
        `INSERT INTO warmup_history_run_events(owner_id,run_id,revision,plan_id,plan_revision,type,state,completed_count,error_count,created_at) VALUES ('alice',?,?,?,1,'run.snapshot','planned',0,0,?)`,
      )
      .bind(saved.id, i + 1, planId, stamp),
  );
  await mocks.db.batch(statements);
  const first = (await (await activity()).json()) as {
    events: WarmupRunActivityEvent[];
    nextCursor: string;
  };
  const second = (await (await activity(first.nextCursor)).json()) as {
    events: WarmupRunActivityEvent[];
    nextCursor: null;
  };
  expect(first.events).toHaveLength(50);
  expect(first.events[0].runId).toBe(otherId);
  expect(first.events[1].revision).toBe(52);
  expect(second.events.map((e) => e.revision)).toEqual([3, 2, 1]);
  expect(second.nextCursor).toBeNull();
  expect(
    new Set([...first.events, ...second.events].map((e) => e.id)).size,
  ).toBe(53);
  for (const cursor of [
    'bad',
    JSON.stringify([stamp, saved.id]),
    JSON.stringify([stamp, saved.id, 0]),
    JSON.stringify([stamp, saved.id, 1.5]),
    JSON.stringify(['2026-02-30T15:00:00.000Z', saved.id, 1]),
  ])
    expect((await activity(cursor)).status).toBe(400);
});
