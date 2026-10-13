import { DatabaseSync } from 'node:sqlite';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';
import { conditionalSellTerms } from '@/lib/conditional-sell-order';
import { conditionalOrderTerms } from '@/lib/conditional-order';
import {
  acquisitionWallet,
  acquisitionMint,
} from '../../../../test/imported-sell-acquisition-fixture';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  decodeOperationPage,
  historyCursor,
} from '@/lib/token-operation-history';
const context = vi.hoisted(() => ({
  user: { userId: 'owner' } as { userId: string } | null,
  db: null as D1Database | null,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => context.user,
}));
vi.mock('@/db', () => ({ getD1: () => context.db }));
import { GET } from './route';
import { tokenWithdrawalFixture } from '../../../../test/token-withdrawal-fixture';
import { nativeWithdrawalFixture } from '../../../../test/native-withdrawal-fixture';
import { decodeTokenWithdrawalReceipt } from '@/lib/token-withdrawal-server';
import { POST as manageConditionalOrder } from '../conditional-orders/route';
import { jitoBundleFixture } from '../../../../test/jito-bundle-fixture';
import { jitoDatabase } from '../../../../test/jito-sqlite';
import { nativeWarmupFixture } from '../../../../test/warmup-native-fixture';
import {
  decodeWarmupReceipt,
  type SavedWarmupBuyReceipt,
} from '@/lib/warmup-buy-receipt';
import { unsignedPreparationSummary } from '@/lib/imported-swap-preparation-history';
import { saveWarmupSellReceipt } from '@/lib/warmup-sell-receipt';
import type { SavedWarmupPreparation } from '@/lib/warmup-preparation-history';
const projectId = '11111111-1111-4111-8111-111111111111',
  otherProject = '22222222-2222-4222-8222-222222222222',
  date = '2026-10-13T00:00:00.000Z';
const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const conditionalTerms = () =>
  conditionalSellTerms(
    {
      projectId,
      projectRevision: 1,
      wallet: acquisitionWallet,
      walletRevision: 1,
      pair: acquisitionMint,
      kind: 'grid',
      direction: 'at-or-above',
      amount: '0.000013',
      minimumUsd: '4064',
      maximumUsd: '4877',
      lines: 5,
    },
    { chain: 'Solana', address: acquisitionMint, decimals: 6 },
  );
let sqlite: DatabaseSync;
beforeEach(() => {
  context.user = { userId: 'owner' };
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT);
  CREATE TABLE imported_token_project_events(id TEXT,owner_id TEXT,project_id TEXT,type TEXT,revision INTEGER,created_at TEXT);
  CREATE TABLE imported_swap_preparations(id TEXT,owner_id TEXT,project_id TEXT,project_revision INTEGER,document TEXT,created_at TEXT);`);
  sqlite
    .prepare('INSERT INTO imported_token_projects VALUES(?,?)')
    .run('owner', projectId);
  sqlite
    .prepare('INSERT INTO imported_token_projects VALUES(?,?)')
    .run('other', otherProject);
  const adapter = {
    prepare(sql: string) {
      let binds: (string | number | null)[] = [];
      const statement = {
        bind(...values: (string | number | null)[]) {
          binds = values;
          return statement;
        },
        async first() {
          return sqlite.prepare(sql).get(...binds) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...binds) };
        },
      };
      return statement;
    },
  };
  context.db = adapter as unknown as D1Database;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Provider call forbidden.');
    }),
  );
});
afterEach(() => {
  sqlite.close();
  vi.unstubAllGlobals();
});
function event(
  n: number,
  owner = 'owner',
  project = projectId,
  createdAt = date,
) {
  sqlite
    .prepare('INSERT INTO imported_token_project_events VALUES(?,?,?,?,?,?)')
    .run(id(n), owner, project, 'project.settings', n, createdAt);
}
const request = (params: Record<string, string> = {}) =>
  new Request(
    'http://localhost/api/imported-projects/operation-history?' +
      new URLSearchParams({ projectId, ...params }),
  );
it('authenticates and checks owned project/filter/cursor context', async () => {
  context.user = null;
  expect((await GET(request())).status).toBe(401);
  context.user = { userId: 'owner' };
  expect((await GET(request({ projectId: otherProject }))).status).toBe(404);
  expect((await GET(request({ category: 'Withdraw' }))).status).toBe(400);
  expect(
    (
      await GET(
        request({
          cursor: historyCursor(otherProject, 'All', 'project:' + id(1)),
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await GET(
        request({
          cursor: historyCursor(projectId, 'All', 'project:' + id(99)),
        }),
      )
    ).status,
  ).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});
it('retains mixed conditional Buy and legacy Sell history without confusing SOL budgets with target-token units', async () => {
  sqlite.exec(
    'CREATE TABLE conditional_order_events(sequence INTEGER,id TEXT,owner_id TEXT,project_id TEXT,order_id TEXT,type TEXT,document TEXT,created_at TEXT);',
  );
  const buy = {
    id: id(500),
    revision: 1,
    state: 'draft',
    createdAt: date,
    updatedAt: date,
    terms: conditionalOrderTerms(
      {
        side: 'Buy',
        projectId,
        projectRevision: 1,
        wallet: acquisitionWallet,
        walletRevision: 1,
        pair: acquisitionMint,
        kind: 'grid',
        direction: 'at-or-below',
        amount: '0.000000011',
        minimumUsd: '100',
        maximumUsd: '200',
        lines: 3,
      },
      { chain: 'Solana', address: acquisitionMint, decimals: 6 },
    ),
  };
  const sell = {
    id: id(501),
    revision: 1,
    state: 'draft',
    createdAt: date,
    updatedAt: date,
    terms: conditionalTerms(),
  };
  for (const [sequence, saved] of [buy, sell].entries())
    sqlite
      .prepare('INSERT INTO conditional_order_events VALUES(?,?,?,?,?,?,?,?)')
      .run(
        sequence + 1,
        id(600 + sequence),
        'owner',
        projectId,
        saved.id,
        'order.saved',
        JSON.stringify(saved),
        date,
      );
  const response = await GET(request({ category: 'Conditional' }));
  expect(response.status).toBe(200);
  const records = decodeOperationPage(
    await response.json(),
    projectId,
    'Conditional',
  ).records;
  const bought = records.find((record) =>
    record.details.some((detail) => detail.includes(buy.id)),
  )!;
  const sold = records.find((record) =>
    record.details.some((detail) => detail.includes(sell.id)),
  )!;
  expect(bought.details.join(' ')).toContain('grid buy with 3 levels');
  expect(bought.details.join(' ')).toContain('11 atomic SOL input units');
  expect(bought.details.join(' ')).not.toContain('11 atomic token units');
  expect(sold.details.join(' ')).toContain('13 atomic token units');
  expect(bought.signature).toBeNull();
  expect(bought.details.join(' ')).toContain(
    'configuration is not trigger evidence',
  );
  expect(fetch).not.toHaveBeenCalled();
});
it('paginates one ordered merged source window through equal timestamps without duplicating later inserts', async () => {
  for (let n = 1; n <= 70; n++) event(n);
  const preparation = {
    executionAllowed: false,
    side: 'Buy',
    wallet: '11111111111111111111111111111111',
    inAmountRaw: '5',
    simulation: { succeeded: true },
    transaction: { secret: 'must-not-return' },
  };
  sqlite
    .prepare('INSERT INTO imported_swap_preparations VALUES(?,?,?,?,?,?)')
    .run(id(90), 'owner', projectId, 1, JSON.stringify(preparation), date);
  event(200, 'other', otherProject);
  event(201, 'owner', otherProject);
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const first = decodeOperationPage(await response.json(), projectId, 'All');
  expect(first.records).toHaveLength(50);
  expect(first.records[0].source).toBe('project');
  event(300);
  event(301, 'owner', projectId, '2026-10-13T00:01:00.000Z');
  const second = decodeOperationPage(
    await (await GET(request({ cursor: first.nextCursor! }))).json(),
    projectId,
    'All',
  );
  expect(second.records).toHaveLength(21);
  expect(second.nextCursor).toBeNull();
  expect(
    new Set([...first.records, ...second.records].map((r) => r.key)).size,
  ).toBe(71);
  expect(second.records.at(-1)).toMatchObject({
    source: 'preparation',
    state: 'simulated',
  });
  expect(JSON.stringify(second)).not.toContain('must-not-return');
  expect(fetch).not.toHaveBeenCalled();
});
it('applies category selection before pagination and rejects cross-category cursors', async () => {
  for (let n = 1; n <= 60; n++) event(n);
  const first = decodeOperationPage(
    await (await GET(request())).json(),
    projectId,
    'All',
  );
  expect(
    (await GET(request({ category: 'Project', cursor: first.nextCursor! })))
      .status,
  ).toBe(400);
  const empty = decodeOperationPage(
    await (await GET(request({ category: 'Buy' }))).json(),
    projectId,
    'Buy',
  );
  expect(empty.records).toEqual([]);
  expect(empty.nextCursor).toBeNull();
});
it('exposes unavailable source storage without claiming complete history', async () => {
  event(1);
  const page = decodeOperationPage(
    await (await GET(request())).json(),
    projectId,
    'All',
  );
  expect(page.missingSources).toEqual([
    'signing',
    'session',
    'bundle',
    'job',
    'conditional',
    'warmup',
    'withdrawal',
  ]);
  expect(page.executionAllowed).toBe(false);
  expect(page.records).toHaveLength(1);
  sqlite.exec(
    'DROP TABLE imported_token_project_events; DROP TABLE imported_swap_preparations;',
  );
  const missing = decodeOperationPage(
    await (await GET(request())).json(),
    projectId,
    'All',
  );
  expect(missing.records).toEqual([]);
  expect(missing.missingSources).toHaveLength(9);
});
it('fails malformed installed source storage instead of silently claiming absence', async () => {
  sqlite.exec('CREATE TABLE jito_bundle_events(id TEXT);');
  expect((await GET(request())).status).toBe(503);
});
it('withholds contradictory retained preparation evidence and foreign-owner anchors', async () => {
  sqlite
    .prepare('INSERT INTO imported_swap_preparations VALUES(?,?,?,?,?,?)')
    .run(id(10), 'owner', projectId, 1, '{"executionAllowed":true}', date);
  expect((await GET(request())).status).toBe(503);
  sqlite.exec('DELETE FROM imported_swap_preparations;');
  event(4, 'other', projectId);
  expect(
    (
      await GET(
        request({
          cursor: historyCursor(projectId, 'All', 'project:' + id(4)),
        }),
      )
    ).status,
  ).toBe(400);
});

it('reads validated signing, session and Jito events together without duplicating session approval projections', async () => {
  const f = await jitoBundleFixture();
  sqlite.close();
  const database = jitoDatabase(f.manifest);
  sqlite = database.sqlite;
  context.db = database.db;
  sqlite.exec(`CREATE TABLE imported_token_project_events(id TEXT,owner_id TEXT,project_id TEXT,type TEXT,revision INTEGER,created_at TEXT);
  CREATE TABLE imported_swap_signing_events(id TEXT,sequence INTEGER,owner_id TEXT,project_id TEXT,intent_id TEXT,preparation_id TEXT,project_revision INTEGER,wallet_revision INTEGER,wallet_address TEXT,type TEXT,state TEXT,signature TEXT,failure_receipt TEXT,document TEXT,created_at TEXT);
  CREATE TABLE imported_trade_session_events(id TEXT,sequence INTEGER,owner_id TEXT,project_id TEXT,session_id TEXT,type TEXT,document TEXT,approval TEXT,control TEXT,created_at TEXT);`);
  sqlite.exec(
    'CREATE TABLE session_preparation_job_events(sequence INTEGER,id TEXT,owner_id TEXT,project_id TEXT,session_id TEXT,job_id TEXT,document TEXT,created_at TEXT);',
  );
  sqlite.exec(
    'CREATE TABLE conditional_order_events(sequence INTEGER,id TEXT,owner_id TEXT,project_id TEXT,order_id TEXT,type TEXT,document TEXT,created_at TEXT);',
  );
  const p = f.manifest.projectId,
    now = f.manifest.createdAt;
  sqlite.prepare('UPDATE imported_swap_preparations SET document=?').run(
    JSON.stringify({
      executionAllowed: false,
      side: 'Buy',
      wallet: f.swap.wallet,
      inAmountRaw: '1000000',
      simulation: { succeeded: true },
    }),
  );
  sqlite
    .prepare('INSERT INTO imported_token_project_events VALUES(?,?,?,?,?,?)')
    .run(id(1), 'owner', p, 'project.import', 1, now);
  const signingDocument = {
    side: 'Buy',
    sha256: 'ab'.repeat(32),
    inputMint: f.review.inputMint,
    outputMint: f.review.outputMint,
    inputRaw: '1000000',
    minimumOutputRaw: '1',
  };
  database.attach();
  sqlite
    .prepare(
      'INSERT INTO imported_swap_signing_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      'ab'.repeat(16),
      1,
      'owner',
      p,
      id(2),
      f.review.preparationId,
      1,
      1,
      f.swap.wallet,
      'approval.reviewed',
      'awaiting_signature',
      null,
      null,
      JSON.stringify(signingDocument),
      now,
    );
  const session = {
    id: f.manifest.sessionId,
    revision: 1,
    state: 'active',
    createdAt: now,
    updatedAt: now,
    terms: {
      format: 'imported-trade-session-v1',
      projectId: p,
      projectRevision: 1,
      mint: f.review.outputMint,
      decimals: 6,
      side: 'Buy',
      totalRaw: '1000000',
      entries: [
        {
          entry: 1,
          wallet: f.swap.wallet,
          walletRevision: 1,
          unitsRaw: '1000000',
          amount: '0.001',
        },
      ],
    },
  };
  sqlite
    .prepare(
      'INSERT INTO imported_trade_session_events VALUES(?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      'cd'.repeat(16),
      1,
      'owner',
      p,
      session.id,
      'session.saved',
      JSON.stringify(session),
      null,
      null,
      now,
    );
  sqlite
    .prepare(
      'INSERT INTO imported_trade_session_events VALUES(?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      'ef'.repeat(16),
      2,
      'owner',
      p,
      session.id,
      'approval.reviewed',
      JSON.stringify(session),
      '{}',
      null,
      now,
    );
  const response = await GET(request({ projectId: p }));
  expect(response.status).toBe(200);
  const page = decodeOperationPage(await response.json(), p, 'All');
  expect(new Set(page.records.map((r) => r.source))).toEqual(
    new Set(['project', 'preparation', 'signing', 'session', 'bundle']),
  );
  expect(page.missingSources).toEqual(['warmup', 'withdrawal']);
  expect(page.records).toHaveLength(5);
  expect(page.records.find((r) => r.source === 'signing')).toMatchObject({
    state: 'awaiting_signature',
    signature: null,
  });
  expect(page.records.find((r) => r.source === 'bundle')).toMatchObject({
    state: 'reviewed',
  });
  expect(page.records.find((r) => r.source === 'session')).toMatchObject({
    key: 'session:' + 'cd'.repeat(16),
    sessionEventId: 'cd'.repeat(16),
  });
  const buy = decodeOperationPage(
    await (await GET(request({ projectId: p, category: 'Buy' }))).json(),
    p,
    'Buy',
  );
  expect(buy.records).toHaveLength(1);
  for (const [n, state, attempts, error] of [
    [1, 'queued', 0, null],
    [2, 'running', 1, null],
    [3, 'failed', 1, 'balance-unavailable'],
    [4, 'cancelled', 1, 'context-changed'],
  ] as const) {
    sqlite
      .prepare(
        'INSERT INTO session_preparation_job_events VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        n,
        n.toString(16).padStart(32, '0'),
        'owner',
        p,
        session.id,
        id(10),
        JSON.stringify({
          id: id(10),
          entry: 1,
          state,
          attempts,
          preparationId: null,
          error,
        }),
        now,
      );
  }
  const jobs = decodeOperationPage(
    await (await GET(request({ projectId: p, category: 'Jobs' }))).json(),
    p,
    'Jobs',
  );
  expect(jobs.records.map((r) => r.state)).toEqual([
    'cancelled',
    'failed',
    'running',
    'queued',
  ]);
  expect(
    jobs.records.every((r) => r.details.some((d) => d.includes(f.swap.wallet))),
  ).toBe(true);
  expect(jobs.records[1].details.join(' ')).toContain('balance-unavailable');
  expect(jobs.records[0].details.join(' ')).toContain(
    'does not sign, submit or prove a trade',
  );
  sqlite
    .prepare(
      "UPDATE imported_trade_session_events SET document=? WHERE type='session.saved'",
    )
    .run(
      JSON.stringify({
        ...session,
        terms: {
          ...session.terms,
          entries: [{ ...session.terms.entries[0], entry: 2 }],
        },
      }),
    );
  expect((await GET(request({ projectId: p, category: 'Jobs' }))).status).toBe(
    503,
  );
  sqlite
    .prepare(
      "UPDATE imported_trade_session_events SET document=? WHERE type='session.saved'",
    )
    .run(JSON.stringify(session));
  sqlite
    .prepare(
      "UPDATE imported_swap_signing_events SET state='failed',type='approval.failed',signature=?",
    )
    .run('1'.repeat(64));
  const failed = decodeOperationPage(
    await (await GET(request({ projectId: p, category: 'Buy' }))).json(),
    p,
    'Buy',
  );
  expect(failed.records[0]).toMatchObject({
    state: 'failed',
    label: 'Buy: Failed approval recorded',
  });
  expect(failed.records[0].details.join(' ')).toContain(
    'no retained failure receipt',
  );
  sqlite
    .prepare(
      "UPDATE imported_swap_signing_events SET state='cancelled',type='approval.cancelled',signature=NULL",
    )
    .run();
  const cancelled = decodeOperationPage(
    await (await GET(request({ projectId: p, category: 'Buy' }))).json(),
    p,
    'Buy',
  );
  expect(cancelled.records[0]).toMatchObject({
    state: 'cancelled',
    signature: null,
  });
  sqlite
    .prepare("UPDATE imported_swap_signing_events SET state='finalized'")
    .run();
  expect((await GET(request({ projectId: p }))).status).toBe(503);
  expect(fetch).not.toHaveBeenCalled();
});

it('retains job outcomes without inventing missing wallet mappings and scopes tied job pages', async () => {
  sqlite.exec(
    'CREATE TABLE session_preparation_job_events(sequence INTEGER,id TEXT,owner_id TEXT,project_id TEXT,session_id TEXT,job_id TEXT,document TEXT,created_at TEXT);',
  );
  const insert = (n: number, owner = 'owner', project = projectId) =>
    sqlite
      .prepare(
        'INSERT INTO session_preparation_job_events VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        n,
        n.toString(16).padStart(32, '0'),
        owner,
        project,
        id(9),
        id(10),
        JSON.stringify({
          id: id(10),
          entry: 1,
          state: 'failed',
          attempts: 3,
          preparationId: null,
          error: 'service-unavailable',
        }),
        date,
      );
  for (let n = 1; n <= 55; n++) insert(n);
  insert(100, 'other');
  insert(101, 'owner', otherProject);
  const first = decodeOperationPage(
    await (await GET(request({ category: 'Jobs' }))).json(),
    projectId,
    'Jobs',
  );
  expect(first.records).toHaveLength(50);
  expect(first.records[0].details.join(' ')).toContain(
    'Wallet mapping unavailable',
  );
  expect(first.missingSources).toContain('session');
  insert(200);
  const second = decodeOperationPage(
    await (
      await GET(request({ category: 'Jobs', cursor: first.nextCursor! }))
    ).json(),
    projectId,
    'Jobs',
  );
  expect(second.records).toHaveLength(5);
  expect(second.nextCursor).toBeNull();
  expect(
    new Set([...first.records, ...second.records].map((r) => r.key)).size,
  ).toBe(55);
  sqlite
    .prepare(
      'UPDATE session_preparation_job_events SET document=? WHERE sequence=200',
    )
    .run(
      JSON.stringify({
        id: id(10),
        entry: 1,
        state: 'skipped',
        attempts: 1,
        preparationId: null,
        error: null,
      }),
    );
  expect((await GET(request({ category: 'Jobs' }))).status).toBe(503);
  expect(fetch).not.toHaveBeenCalled();
});

it('runs project-scoped job mapping and tied-page continuation through disposable Cloudflare D1', async () => {
  const mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'token-history-d1',
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
          env: { DB: { type: 'd1', id: 'token-history-only' } },
        },
      },
    ],
  });
  try {
    const db = await mf.getD1Database('DB', 'token-history-d1');
    context.db = db;
    for (const migration of [
      '0056_conditional_sell_orders',
      '0071_curious_glorian',
    ])
      await db.batch(
        readFileSync(`drizzle/${migration}.sql`, 'utf8')
          .split('--> statement-breakpoint')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => db.prepare(s)),
      );
    for (const table of [
      'imported_token_projects(owner_id TEXT,id TEXT)',
      'imported_trade_session_events(id TEXT,sequence INTEGER,owner_id TEXT,project_id TEXT,session_id TEXT,type TEXT,document TEXT,approval TEXT,control TEXT,created_at TEXT)',
      'session_preparation_job_events(sequence INTEGER,id TEXT,owner_id TEXT,project_id TEXT,session_id TEXT,job_id TEXT,document TEXT,created_at TEXT)',
    ])
      await db.prepare('CREATE TABLE ' + table).run();
    await db
      .prepare('INSERT INTO imported_token_projects VALUES(?,?)')
      .bind('owner', projectId)
      .run();
    const wallet = '11111111111111111111111111111111';
    const session = {
      id: id(9),
      revision: 1,
      state: 'active',
      createdAt: date,
      updatedAt: date,
      terms: {
        format: 'imported-trade-session-v1',
        projectId,
        projectRevision: 1,
        mint: wallet,
        decimals: 6,
        side: 'Buy',
        totalRaw: '1000000',
        entries: [
          {
            entry: 1,
            wallet,
            walletRevision: 2,
            unitsRaw: '1000000',
            amount: '0.001',
          },
        ],
      },
    };
    await db
      .prepare(
        'INSERT INTO imported_trade_session_events VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        'cd'.repeat(16),
        1,
        'owner',
        projectId,
        id(9),
        'session.saved',
        JSON.stringify(session),
        null,
        null,
        date,
      )
      .run();
    const sessions = decodeOperationPage(
      await (await GET(request({ category: 'Session' }))).json(),
      projectId,
      'Session',
    );
    expect(sessions.records).toHaveLength(1);
    expect(sessions.records[0]).toMatchObject({
      key: 'session:' + 'cd'.repeat(16),
      sessionEventId: 'cd'.repeat(16),
    });
    const job = {
      id: id(10),
      entry: 1,
      state: 'failed',
      attempts: 3,
      preparationId: null,
      error: 'service-unavailable',
    };
    await db.batch(
      Array.from({ length: 54 }, (_, i) =>
        db
          .prepare(
            'INSERT INTO session_preparation_job_events VALUES(?,?,?,?,?,?,?,?)',
          )
          .bind(
            i + 1,
            (i + 1).toString(16).padStart(32, '0'),
            'owner',
            projectId,
            id(9),
            id(10),
            JSON.stringify(job),
            date,
          ),
      ),
    );
    await db
      .prepare(
        'INSERT INTO session_preparation_job_events VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(
        99,
        'ff'.repeat(16),
        'other',
        projectId,
        id(9),
        id(10),
        JSON.stringify(job),
        date,
      )
      .run();
    const response = await GET(request({ category: 'Jobs' }));
    expect(response.status).toBe(200);
    const first = decodeOperationPage(await response.json(), projectId, 'Jobs');
    expect(first.records).toHaveLength(50);
    expect(first.records[0].details.join(' ')).toContain(
      `Wallet ${wallet}; wallet revision 2`,
    );
    const second = decodeOperationPage(
      await (
        await GET(request({ category: 'Jobs', cursor: first.nextCursor! }))
      ).json(),
      projectId,
      'Jobs',
    );
    expect(second.records).toHaveLength(4);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.records, ...second.records].map((r) => r.key)).size,
    ).toBe(54);
    await db
      .prepare('INSERT INTO conditional_sell_orders VALUES(?,?,?,?,?,?,?,?)')
      .bind(
        'owner',
        id(20),
        projectId,
        JSON.stringify(conditionalTerms()),
        'draft',
        1,
        date,
        date,
      )
      .run();
    const cancelledAt = '2026-10-13T00:00:01.000Z';
    await db
      .prepare(
        "UPDATE conditional_sell_orders SET state='cancelled',revision=2,updated_at=? WHERE owner_id=? AND id=?",
      )
      .bind(cancelledAt, 'owner', id(20))
      .run();
    const conditional = decodeOperationPage(
      await (await GET(request({ category: 'Conditional' }))).json(),
      projectId,
      'Conditional',
    );
    expect(conditional.records.map((r) => r.state)).toEqual([
      'cancelled',
      'draft',
    ]);
    expect(conditional.records[1].details.join(' ')).toContain(
      'Order configuration is not trigger evidence',
    );
    await expect(
      db.prepare('DELETE FROM conditional_order_events').run(),
    ).rejects.toThrow();
    for (const column of [
      'revision INTEGER DEFAULT 1',
      'archived INTEGER DEFAULT 0',
      'chain TEXT',
      'address TEXT',
      'document TEXT',
    ])
      await db
        .prepare('ALTER TABLE imported_token_projects ADD COLUMN ' + column)
        .run();
    await db
      .prepare(
        'UPDATE imported_token_projects SET chain=?,address=?,document=? WHERE owner_id=? AND id=?',
      )
      .bind(
        'Solana',
        acquisitionMint,
        JSON.stringify({
          token: { chain: 'Solana', address: acquisitionMint, decimals: 6 },
        }),
        'owner',
        projectId,
      )
      .run();
    await db
      .prepare(
        'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER)',
      )
      .run();
    await db
      .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?)')
      .bind('owner', 'Solana', acquisitionWallet, 1, 0)
      .run();
    await db
      .prepare(
        'CREATE TABLE conditional_level_reservations(owner_id TEXT,order_id TEXT)',
      )
      .run();
    const manage = (body: unknown) =>
      manageConditionalOrder(
        new Request(
          'http://localhost/api/imported-projects/conditional-orders',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        ),
      );
    const create = {
      action: 'create',
      orderId: id(30),
      projectId,
      projectRevision: 1,
      wallet: acquisitionWallet,
      walletRevision: 1,
      pair: acquisitionMint,
      kind: 'grid',
      direction: 'at-or-above',
      amount: '0.000013',
      minimumUsd: '4064',
      maximumUsd: '4877',
      lines: 5,
    };
    expect((await manage(create)).status).toBe(200);
    expect((await manage(create)).status).toBe(200);
    const cancel = {
      action: 'cancel',
      orderId: id(30),
      projectId,
      revision: 1,
    };
    expect((await manage(cancel)).status).toBe(200);
    expect((await manage(cancel)).status).toBe(200);
    const liveHistory = decodeOperationPage(
      await (await GET(request({ category: 'Conditional' }))).json(),
      projectId,
      'Conditional',
    );
    const created = liveHistory.records.filter((r) =>
      r.details.some((d) => d.includes(id(30))),
    );
    expect(created.map((r) => r.state)).toEqual(['cancelled', 'draft']);
    expect(liveHistory.records).toHaveLength(4);
    await db
      .prepare(
        'CREATE TABLE native_withdrawals(id TEXT,owner_id TEXT,wallet_address TEXT,wallet_revision INTEGER,document TEXT,receipt TEXT,created_at TEXT)',
      )
      .run();
    await db
      .prepare(
        'CREATE TABLE native_withdrawal_events(sequence INTEGER,owner_id TEXT,intent_id TEXT,wallet_address TEXT,state TEXT,signature TEXT,failure_receipt TEXT,created_at TEXT)',
      )
      .run();
    const transfer = await tokenWithdrawalFixture(true, true, true, {
      mint: acquisitionMint,
      amountRaw: 1000000n,
    });
    const transferProof = await decodeTokenWithdrawalReceipt(
      transfer.receipt,
      transfer.review,
      transfer.signed.signature,
    );
    await db
      .prepare('INSERT INTO native_withdrawals VALUES(?,?,?,?,?,?,?)')
      .bind(
        transfer.review.id,
        'owner',
        transfer.wallet,
        transfer.review.walletRevision,
        JSON.stringify(transfer.review),
        JSON.stringify(transferProof),
        transfer.review.preparedAt,
      )
      .run();
    await db.batch(
      ['awaiting_signature', 'signed', 'finalized'].map((state, i) =>
        db
          .prepare(
            'INSERT INTO native_withdrawal_events VALUES(?,?,?,?,?,?,?,?)',
          )
          .bind(
            i + 1,
            'owner',
            transfer.review.id,
            transfer.wallet,
            state,
            i === 0 ? null : transfer.signed.signature,
            null,
            transfer.review.preparedAt,
          ),
      ),
    );
    const withdrawals = decodeOperationPage(
      await (await GET(request({ category: 'Withdrawals' }))).json(),
      projectId,
      'Withdrawals',
    );
    expect(withdrawals.records.map((r) => r.state)).toEqual([
      'finalized',
      'signed',
      'awaiting_signature',
    ]);
    expect(withdrawals.records[0].details.join(' ')).toContain(
      `token fee ${transfer.review.token!.transferFee!.feeRaw}`,
    );
    expect(withdrawals.records[1].details.join(' ')).toContain(
      'No successful finalized transfer receipt',
    );
    expect(JSON.stringify(withdrawals)).not.toContain(
      transfer.review.transaction,
    );
    context.user = { userId: 'other' };
    expect((await GET(request({ category: 'Jobs' }))).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await mf.dispose();
  }
}, 30000);

it('atomically retains conditional creation/cancellation without backfilling prior orders or allowing history mutation', async () => {
  sqlite.exec(readFileSync('drizzle/0056_conditional_sell_orders.sql', 'utf8'));
  const insert = (n: number) =>
    sqlite
      .prepare('INSERT INTO conditional_sell_orders VALUES(?,?,?,?,?,?,?,?)')
      .run(
        'owner',
        id(n),
        projectId,
        JSON.stringify(conditionalTerms()),
        'draft',
        1,
        date,
        date,
      );
  insert(19);
  sqlite.exec(readFileSync('drizzle/0071_curious_glorian.sql', 'utf8'));
  expect(
    sqlite.prepare('SELECT count(*) AS n FROM conditional_order_events').get()!
      .n,
  ).toBe(0);
  insert(20);
  const first = decodeOperationPage(
    await (await GET(request({ category: 'Conditional' }))).json(),
    projectId,
    'Conditional',
  );
  expect(first.records).toHaveLength(1);
  expect(first.records[0].state).toBe('draft');
  sqlite
    .prepare(
      "UPDATE conditional_sell_orders SET state='cancelled',revision=2,updated_at=? WHERE id=?",
    )
    .run('2026-10-13T00:00:01.000Z', id(20));
  const page = decodeOperationPage(
    await (await GET(request({ category: 'Conditional' }))).json(),
    projectId,
    'Conditional',
  );
  expect(page.records.map((r) => r.state)).toEqual(['cancelled', 'draft']);
  expect(page.records[1].details.join(' ')).toContain('5 levels');
  expect(() =>
    sqlite.exec("UPDATE conditional_order_events SET type='order.saved'"),
  ).toThrow('immutable');
  expect(() => sqlite.exec('DELETE FROM conditional_order_events')).toThrow(
    'retained',
  );
  expect(() =>
    sqlite
      .prepare("UPDATE conditional_sell_orders SET document='{}' WHERE id=?")
      .run(id(20)),
  ).toThrow('lifecycle differs');
  expect(() => sqlite.exec('DELETE FROM conditional_sell_orders')).toThrow(
    'retained',
  );
  sqlite.exec('BEGIN');
  insert(21);
  sqlite.exec('ROLLBACK');
  expect(
    sqlite.prepare('SELECT count(*) AS n FROM conditional_order_events').get()!
      .n,
  ).toBe(2);
  insert(22);
  sqlite.exec(
    "CREATE TRIGGER test_refuse_conditional_history BEFORE INSERT ON conditional_order_events BEGIN SELECT RAISE(ABORT,'History refused'); END;",
  );
  expect(() =>
    sqlite
      .prepare(
        "UPDATE conditional_sell_orders SET state='cancelled',revision=2,updated_at=? WHERE id=?",
      )
      .run('2026-10-13T00:00:01.000Z', id(22)),
  ).toThrow('History refused');
  expect(
    sqlite
      .prepare('SELECT state FROM conditional_sell_orders WHERE id=?')
      .get(id(22))!.state,
  ).toBe('draft');
});

it('attributes token withdrawals by retained mint, excludes SOL and other mints, and rejects contradictory settlement', async () => {
  const f = await tokenWithdrawalFixture(true, true, true),
    native = await nativeWithdrawalFixture();
  const proof = await decodeTokenWithdrawalReceipt(
    f.receipt,
    f.review,
    f.signed.signature,
  );
  if (!('token' in proof) || !proof.token)
    throw new Error('Successful token receipt expected in fixture.');
  sqlite.exec(
    'ALTER TABLE imported_token_projects ADD COLUMN chain TEXT; ALTER TABLE imported_token_projects ADD COLUMN address TEXT; CREATE TABLE native_withdrawals(id TEXT,owner_id TEXT,wallet_address TEXT,wallet_revision INTEGER,document TEXT,receipt TEXT,created_at TEXT); CREATE TABLE native_withdrawal_events(sequence INTEGER,owner_id TEXT,intent_id TEXT,wallet_address TEXT,state TEXT,signature TEXT,failure_receipt TEXT,created_at TEXT);',
  );
  sqlite
    .prepare('UPDATE imported_token_projects SET chain=?,address=? WHERE id=?')
    .run('Solana', f.mint, projectId);
  sqlite
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,?,?)')
    .run('owner', id(400), 'Solana', acquisitionMint);
  const retain = (review: typeof f.review, receipt: unknown) =>
    sqlite
      .prepare('INSERT INTO native_withdrawals VALUES(?,?,?,?,?,?,?)')
      .run(
        review.id,
        'owner',
        review.wallet,
        review.walletRevision,
        JSON.stringify(review),
        receipt ? JSON.stringify(receipt) : null,
        review.preparedAt,
      );
  retain(f.review, proof);
  retain(native.review, null);
  for (const [i, state] of [
    'awaiting_signature',
    'signed',
    'submitted',
    'finalized',
  ].entries())
    sqlite
      .prepare('INSERT INTO native_withdrawal_events VALUES(?,?,?,?,?,?,?,?)')
      .run(
        i + 1,
        'owner',
        f.review.id,
        f.wallet,
        state,
        i ? f.signed.signature : null,
        null,
        f.review.preparedAt,
      );
  sqlite
    .prepare('INSERT INTO native_withdrawal_events VALUES(?,?,?,?,?,?,?,?)')
    .run(
      99,
      'owner',
      native.review.id,
      native.wallet,
      'awaiting_signature',
      null,
      null,
      native.review.preparedAt,
    );
  const page = decodeOperationPage(
    await (await GET(request({ category: 'Withdrawals' }))).json(),
    projectId,
    'Withdrawals',
  );
  expect(page.records).toHaveLength(4);
  expect(page.records[0].state).toBe('finalized');
  expect(page.records[0].details.join(' ')).toContain(f.review.amount);
  expect(page.records[0].details.join(' ')).toContain(
    'Account-wide SOL withdrawals are excluded',
  );
  expect(JSON.stringify(page)).not.toContain(f.review.transaction);
  const other = decodeOperationPage(
    await (
      await GET(request({ projectId: id(400), category: 'Withdrawals' }))
    ).json(),
    id(400),
    'Withdrawals',
  );
  expect(other.records).toEqual([]);
  sqlite.prepare('UPDATE native_withdrawals SET receipt=? WHERE id=?').run(
    JSON.stringify({
      ...proof,
      token: { ...proof.token!, destinationChangeRaw: '0' },
    }),
    f.review.id,
  );
  expect((await GET(request({ category: 'Withdrawals' }))).status).toBe(503);
  expect(fetch).not.toHaveBeenCalled();
});

const warmupSignature = bs58.encode(new Uint8Array(64).fill(3));
const wrappedMint = 'So11111111111111111111111111111111111111112';
function warmupSchema() {
  sqlite.exec(
    'ALTER TABLE imported_token_projects ADD COLUMN chain TEXT; ALTER TABLE imported_token_projects ADD COLUMN address TEXT;' +
      'CREATE TABLE warmup_signing_events(id TEXT,sequence INTEGER,owner_id TEXT,intent_id TEXT,preparation_id TEXT,plan_id TEXT,plan_revision INTEGER,cycle INTEGER,wallet_address TEXT,type TEXT,state TEXT,signature TEXT,failure_receipt TEXT,document TEXT,created_at TEXT);' +
      'CREATE TABLE warmup_swap_preparations(id TEXT,owner_id TEXT,plan_id TEXT,plan_revision INTEGER,cycle INTEGER,wallet_address TEXT,wallet_revision INTEGER,document TEXT,created_at TEXT);' +
      'CREATE TABLE warmup_signing_intents(id TEXT,owner_id TEXT,preparation_id TEXT,wallet_address TEXT,document TEXT,signature TEXT,created_at TEXT);',
  );
  sqlite
    .prepare(
      'UPDATE imported_token_projects SET chain=?,address=? WHERE owner_id=? AND id=?',
    )
    .run('Solana', acquisitionMint, 'owner', projectId);
}
function warmupRecord(
  n: number,
  options: {
    owner?: string;
    mint?: string;
    side?: 'Buy' | 'Sell';
    state?:
      | 'awaiting_signature'
      | 'signed'
      | 'submitted'
      | 'finalized'
      | 'failed'
      | 'cancelled';
    network?: string;
    missingIntent?: boolean;
    missingPreparation?: boolean;
  } = {},
) {
  const owner = options.owner ?? 'owner',
    side = options.side ?? 'Buy',
    state = options.state ?? 'awaiting_signature';
  const mint = options.mint ?? acquisitionMint;
  const terms = {
    side,
    sha256: 'a'.repeat(64),
    inputMint: side === 'Buy' ? wrappedMint : mint,
    outputMint: side === 'Buy' ? mint : wrappedMint,
    inputRaw: '9007199254740993',
    minimumOutputRaw: '42',
  };
  const document = {
    executionAllowed: false,
    instructionsVerified: false,
    chain: 'Solana',
    side,
    wallet: acquisitionWallet,
    inputMint: terms.inputMint,
    outputMint: terms.outputMint,
    inAmountRaw: terms.inputRaw,
    minimumOutRaw: terms.minimumOutputRaw,
    transaction: { sha256: terms.sha256 },
  };
  const review = {
    id: id(n + 2000),
    preparationId: id(n + 1000),
    wallet: acquisitionWallet,
    network: options.network ?? 'mainnet',
    ...terms,
  };
  const preparationId = id(n + 1000),
    intentId = id(n + 2000),
    preparedAt = '2026-10-12T23:00:00.000Z';
  if (!options.missingPreparation)
    sqlite
      .prepare('INSERT INTO warmup_swap_preparations VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        preparationId,
        owner,
        'historical-warmup',
        4,
        2,
        acquisitionWallet,
        7,
        JSON.stringify(document),
        preparedAt,
      );
  if (!options.missingIntent)
    sqlite
      .prepare('INSERT INTO warmup_signing_intents VALUES(?,?,?,?,?,?,?)')
      .run(
        intentId,
        owner,
        preparationId,
        acquisitionWallet,
        JSON.stringify(review),
        ['awaiting_signature', 'cancelled'].includes(state)
          ? null
          : warmupSignature,
        preparedAt,
      );
  const types = {
    awaiting_signature: 'approval.reviewed',
    signed: 'approval.signed',
    submitted: 'approval.submission_started',
    finalized: 'approval.finalized',
    failed: 'approval.failed',
    cancelled: 'approval.cancelled',
  };
  sqlite
    .prepare(
      'INSERT INTO warmup_signing_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      n.toString(16).padStart(32, '0'),
      n,
      owner,
      intentId,
      preparationId,
      'historical-warmup',
      4,
      2,
      acquisitionWallet,
      types[state],
      state,
      ['awaiting_signature', 'cancelled'].includes(state)
        ? null
        : warmupSignature,
      null,
      JSON.stringify(terms),
      date,
    );
  return { preparationId, intentId, terms, document, review, preparedAt };
}
it('merges mint-attributed warmup states with historical context, explicit receipt limits and no unsigned packets', async () => {
  warmupSchema();
  warmupRecord(1);
  warmupRecord(2, { state: 'signed' });
  warmupRecord(3, { state: 'submitted', side: 'Sell' });
  warmupRecord(4, { state: 'finalized' });
  warmupRecord(5, { state: 'failed' });
  warmupRecord(6, { state: 'cancelled' });
  warmupRecord(7, { owner: 'other' });
  warmupRecord(8, { mint: wrappedMint });
  warmupRecord(9, { network: 'devnet' });
  event(100);
  const page = decodeOperationPage(
    await (await GET(request({ category: 'Warmup' }))).json(),
    projectId,
    'Warmup',
  );
  expect(page.records).toHaveLength(6);
  expect(page.records.every((record) => record.source === 'warmup')).toBe(true);
  expect(page.records.map((record) => record.state)).toEqual([
    'cancelled',
    'failed',
    'finalized',
    'submitted',
    'signed',
    'awaiting_signature',
  ]);
  expect(
    page.records.find((record) => record.state === 'submitted')?.label,
  ).toContain('attempt reserved');
  expect(
    page.records.find((record) => record.state === 'finalized')?.label,
  ).toContain('Finalized approval recorded');
  expect(
    page.records.find((record) => record.state === 'failed')?.label,
  ).toContain('evidence unavailable');
  expect(page.records[0].details.join(' ')).toContain('revision 4, cycle 2');
  expect(page.records[0].details.join(' ')).toContain('9007199254740993');
  expect(page.records[0].details.join(' ')).toContain(
    'does not establish that the action was started',
  );
  expect(JSON.stringify(page)).not.toContain('transaction"');
  expect(JSON.stringify(page)).not.toContain('document"');
  const merged = decodeOperationPage(
    await (await GET(request())).json(),
    projectId,
    'All',
  );
  expect(merged.records).toHaveLength(7);
  expect(fetch).not.toHaveBeenCalled();
});
it('retains warmup history when supporting rows disappear without inventing a mainnet link', async () => {
  warmupSchema();
  warmupRecord(1, {
    state: 'signed',
    missingIntent: true,
    missingPreparation: true,
  });
  const page = decodeOperationPage(
    await (await GET(request({ category: 'Warmup' }))).json(),
    projectId,
    'Warmup',
  );
  expect(page.records).toHaveLength(1);
  expect(page.records[0].signature).toBeNull();
  expect(page.records[0].details.join(' ')).toContain(
    'Network evidence is unavailable',
  );
  expect(page.records[0].details.join(' ')).toContain(
    'preparation record is unavailable',
  );
  expect(page.records[0].details.join(' ')).toContain(warmupSignature);
});
it('rejects contradictory warmup preparation, network, exact amounts and event times', async () => {
  warmupSchema();
  const saved = warmupRecord(1);
  sqlite
    .prepare('UPDATE warmup_swap_preparations SET document=?')
    .run(JSON.stringify({ ...saved.document, minimumOutRaw: '1' }));
  expect((await GET(request({ category: 'Warmup' }))).status).toBe(503);
  sqlite
    .prepare('UPDATE warmup_swap_preparations SET document=?')
    .run(JSON.stringify(saved.document));
  sqlite
    .prepare('UPDATE warmup_signing_intents SET document=?')
    .run(JSON.stringify({ ...saved.review, network: 'unknown-network' }));
  expect((await GET(request({ category: 'Warmup' }))).status).toBe(503);
  sqlite
    .prepare('UPDATE warmup_signing_intents SET document=?')
    .run(JSON.stringify(saved.review));
  sqlite
    .prepare('UPDATE warmup_swap_preparations SET created_at=?')
    .run('2026-10-14T00:00:00.000Z');
  expect((await GET(request({ category: 'Warmup' }))).status).toBe(503);
  sqlite
    .prepare('UPDATE warmup_swap_preparations SET created_at=?')
    .run(saved.preparedAt);
  sqlite
    .prepare('UPDATE warmup_signing_events SET document=?')
    .run(JSON.stringify({ ...saved.terms, inputRaw: '18446744073709551616' }));
  expect((await GET(request({ category: 'Warmup' }))).status).toBe(503);
});
it('paginates tied warmup transitions without mutable plan/roster dependencies or foreign cursor leakage', async () => {
  warmupSchema();
  for (let n = 1; n <= 54; n++) warmupRecord(n);
  const first = decodeOperationPage(
    await (await GET(request({ category: 'Warmup' }))).json(),
    projectId,
    'Warmup',
  );
  expect(first.records).toHaveLength(50);
  expect(first.nextCursor).not.toBeNull();
  warmupRecord(55);
  const next = decodeOperationPage(
    await (
      await GET(request({ category: 'Warmup', cursor: first.nextCursor! }))
    ).json(),
    projectId,
    'Warmup',
  );
  expect(next.records).toHaveLength(4);
  expect(
    new Set([...first.records, ...next.records].map((record) => record.key))
      .size,
  ).toBe(54);
  expect(
    (await GET(request({ category: 'Buy', cursor: first.nextCursor! }))).status,
  ).toBe(400);
});

it('binds warmup approval document identity and registered signatures while allowing earlier unsigned transitions', async () => {
  warmupSchema();
  const saved = warmupRecord(1, { state: 'signed' });
  sqlite
    .prepare('UPDATE warmup_signing_intents SET document=?')
    .run(JSON.stringify({ ...saved.review, wallet: acquisitionMint }));
  expect((await GET(request({ category: 'Warmup' }))).status).toBe(503);
  sqlite
    .prepare('UPDATE warmup_signing_intents SET document=?')
    .run(JSON.stringify(saved.review));
  sqlite
    .prepare('UPDATE warmup_signing_intents SET signature=?')
    .run(bs58.encode(new Uint8Array(64).fill(4)));
  expect((await GET(request({ category: 'Warmup' }))).status).toBe(503);
  sqlite
    .prepare('UPDATE warmup_signing_intents SET signature=?')
    .run(warmupSignature);
  sqlite
    .prepare('UPDATE warmup_signing_events SET type=?,state=?,signature=NULL')
    .run('approval.reviewed', 'awaiting_signature');
  const earlier = decodeOperationPage(
    await (await GET(request({ category: 'Warmup' }))).json(),
    projectId,
    'Warmup',
  );
  expect(earlier.records[0].state).toBe('awaiting_signature');
  expect(earlier.records[0].signature).toBeNull();
});
it('uses retained mainnet failure evidence without an intent and rejects contradictory reviewed fees or future observations', async () => {
  warmupSchema();
  const saved = warmupRecord(1, { state: 'failed', missingIntent: true });
  const failure = {
    failed: true,
    network: 'mainnet',
    commitment: 'finalized',
    signatureVerified: true,
    signature: warmupSignature,
    wallet: acquisitionWallet,
    ...saved.terms,
    reviewedFeeLamports: '5000',
    networkFeeLamports: '5000',
    walletChangeRaw: '-5000',
    feeLimitExceeded: false,
    slot: 200,
    blockTime: null,
    error: { type: 'InsufficientFundsForFee' },
    observedAt: '2026-10-12T23:59:00.000Z',
    source: 'receipt-fixture.test',
  };
  sqlite
    .prepare('UPDATE warmup_signing_events SET failure_receipt=?')
    .run(JSON.stringify(failure));
  const page = decodeOperationPage(
    await (await GET(request({ category: 'Warmup' }))).json(),
    projectId,
    'Warmup',
  );
  expect(page.records[0].signature).toBe(warmupSignature);
  expect(page.records[0].details.join(' ')).toContain(
    'Mainnet finalized failure context',
  );
  expect(page.records[0].details.join(' ')).not.toContain(
    'Network evidence is unavailable',
  );
  sqlite
    .prepare('INSERT INTO warmup_signing_intents VALUES(?,?,?,?,?,?,?)')
    .run(
      saved.intentId,
      'owner',
      saved.preparationId,
      acquisitionWallet,
      JSON.stringify({ ...saved.review, maximumFeeLamports: '4000' }),
      warmupSignature,
      saved.preparedAt,
    );
  expect((await GET(request({ category: 'Warmup' }))).status).toBe(503);
  sqlite
    .prepare('UPDATE warmup_signing_intents SET document=?')
    .run(JSON.stringify({ ...saved.review, maximumFeeLamports: '5000' }));
  expect((await GET(request({ category: 'Warmup' }))).status).toBe(200);
  sqlite
    .prepare('UPDATE warmup_signing_events SET failure_receipt=?')
    .run(
      JSON.stringify({ ...failure, observedAt: '2026-10-14T00:00:00.000Z' }),
    );
  expect((await GET(request({ category: 'Warmup' }))).status).toBe(503);
});
it('reads trigger-retained warmup approval history through the actual API on disposable D1 after cancellation, archive and intent removal', async () => {
  const mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'token-warmup-history-test',
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
          env: { DB: { type: 'd1', id: 'token-warmup-history-disposable' } },
        },
      },
    ],
  });
  try {
    const db = await mf.getD1Database('DB', 'token-warmup-history-test');
    context.db = db;
    const journal = JSON.parse(
      readFileSync('drizzle/meta/_journal.json', 'utf8'),
    ) as { entries: { tag: string }[] };
    for (const entry of journal.entries) {
      const sql = readFileSync('drizzle/' + entry.tag + '.sql', 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean);
      await db.batch(sql.map((s) => db.prepare(s)));
    }
    await db
      .prepare(
        'INSERT INTO imported_token_projects(owner_id,id,chain,address,document,revision,archived,mutation_id,updated_at) VALUES(?,?,?,?,?,1,0,?,?)',
      )
      .bind(
        'owner',
        projectId,
        'Solana',
        acquisitionMint,
        '{}',
        'warmup-history-fixture',
        date,
      )
      .run();
    const preparationId = id(7000),
      intentId = id(8000),
      preparedAt = '2026-10-12T23:00:00.000Z';
    const terms = {
      side: 'Buy',
      sha256: 'a'.repeat(64),
      inputMint: wrappedMint,
      outputMint: acquisitionMint,
      inputRaw: '9007199254740993',
      minimumOutputRaw: '42',
    };
    const document = {
      executionAllowed: false,
      instructionsVerified: false,
      chain: 'Solana',
      side: 'Buy',
      wallet: acquisitionWallet,
      inputMint: wrappedMint,
      outputMint: acquisitionMint,
      inAmountRaw: terms.inputRaw,
      minimumOutRaw: terms.minimumOutputRaw,
      transaction: { sha256: terms.sha256 },
    };
    const review = {
      id: intentId,
      preparationId,
      wallet: acquisitionWallet,
      network: 'mainnet',
      maximumFeeLamports: '5000',
      ...terms,
    };
    await db
      .prepare(
        'INSERT INTO warmup_swap_preparations(id,owner_id,plan_id,plan_revision,cycle,wallet_address,wallet_revision,document,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        preparationId,
        'owner',
        'historical-warmup',
        4,
        2,
        acquisitionWallet,
        7,
        JSON.stringify(document),
        preparedAt,
      )
      .run();
    await db
      .prepare(
        'INSERT INTO warmup_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(
        intentId,
        'owner',
        preparationId,
        acquisitionWallet,
        JSON.stringify(review),
        'awaiting_signature',
        date,
        date,
      )
      .run();
    await db
      .prepare(
        'UPDATE warmup_signing_intents SET state=?,updated_at=? WHERE id=?',
      )
      .bind('cancelled', '2026-10-13T00:00:01.000Z', intentId)
      .run();
    await db
      .prepare('UPDATE imported_token_projects SET archived=1 WHERE id=?')
      .bind(projectId)
      .run();
    const page = decodeOperationPage(
      await (await GET(request({ category: 'Warmup' }))).json(),
      projectId,
      'Warmup',
    );
    expect(page.records.map((record) => record.state)).toEqual([
      'cancelled',
      'awaiting_signature',
    ]);
    expect(page.missingSources).toEqual([]);
    expect(
      page.records.every((record) =>
        record.details.join(' ').includes('Mainnet network retained'),
      ),
    ).toBe(true);
    const all = decodeOperationPage(
      await (await GET(request())).json(),
      projectId,
      'All',
    );
    expect(
      all.records.filter((record) => record.source === 'warmup'),
    ).toHaveLength(2);
    for (let n = 1; n <= 53; n++) {
      await db
        .prepare(
          "INSERT INTO warmup_signing_events(id,owner_id,intent_id,preparation_id,plan_id,plan_revision,cycle,wallet_address,type,state,signature,document,created_at,failure_receipt) SELECT ?,owner_id,intent_id,preparation_id,plan_id,plan_revision,cycle,wallet_address,'approval.baseline',state,signature,document,created_at,failure_receipt FROM warmup_signing_events WHERE owner_id=? AND state='awaiting_signature' ORDER BY sequence ASC LIMIT 1",
        )
        .bind(n.toString(16).padStart(32, '0'), 'owner')
        .run();
    }
    const first = decodeOperationPage(
      await (await GET(request({ category: 'Warmup' }))).json(),
      projectId,
      'Warmup',
    );
    expect(first.records).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const older = decodeOperationPage(
      await (
        await GET(request({ category: 'Warmup', cursor: first.nextCursor! }))
      ).json(),
      projectId,
      'Warmup',
    );
    expect(older.records).toHaveLength(5);
    expect(older.nextCursor).toBeNull();
    expect(
      new Set([...first.records, ...older.records].map((record) => record.key))
        .size,
    ).toBe(55);
    const allFirst = decodeOperationPage(
      await (await GET(request())).json(),
      projectId,
      'All',
    );
    expect(allFirst.records).toHaveLength(50);
    const allOlder = decodeOperationPage(
      await (await GET(request({ cursor: allFirst.nextCursor! }))).json(),
      projectId,
      'All',
    );
    expect(allOlder.records).toHaveLength(5);
    expect(
      new Set(
        [...allFirst.records, ...allOlder.records].map((record) => record.key),
      ).size,
    ).toBe(55);
    await db
      .prepare('DELETE FROM warmup_signing_intents WHERE id=?')
      .bind(intentId)
      .run();
    const retained = decodeOperationPage(
      await (await GET(request({ category: 'Warmup' }))).json(),
      projectId,
      'Warmup',
    );
    expect(retained.records).toHaveLength(50);
    expect(
      retained.records.every((record) =>
        record.details.join(' ').includes('Network evidence is unavailable'),
      ),
    ).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    context.user = { userId: 'other' };
    expect((await GET(request({ category: 'Warmup' }))).status).toBe(404);
  } finally {
    await mf.dispose();
  }
});

it('enriches only finalized warmup transitions with presently matching receipt evidence on disposable D1, preserving history through receipt drift and missing tables', async () => {
  const mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'warmup-receipt-history-test',
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
          env: { DB: { type: 'd1', id: 'warmup-receipt-history-disposable' } },
        },
      },
    ],
  });
  try {
    const db = await mf.getD1Database('DB', 'warmup-receipt-history-test');
    context.db = db;
    const journal = JSON.parse(
      readFileSync('drizzle/meta/_journal.json', 'utf8'),
    ) as { entries: { tag: string }[] };
    for (const entry of journal.entries) {
      const chunks = readFileSync('drizzle/' + entry.tag + '.sql', 'utf8')
        .split('--> statement-breakpoint')
        .map((chunk) => chunk.trim())
        .filter(Boolean);
      await db.batch(chunks.map((chunk) => db.prepare(chunk)));
    }
    const b = await nativeWarmupFixture({ v2: true, existing: true });
    const s = await nativeWarmupFixture({
      side: 'Sell',
      v2: true,
      existing: true,
      slot: 200,
    });
    const at = (seconds: number) => `2026-10-13T00:00:0${seconds}.000Z`;
    await db
      .prepare(
        'INSERT INTO imported_token_projects(owner_id,id,chain,address,document,revision,archived,mutation_id,updated_at) VALUES(?,?,?,?,?,1,1,?,?)',
      )
      .bind(
        'owner',
        projectId,
        'Solana',
        b.mint,
        '{}',
        'receipt-history-fixture',
        at(0),
      )
      .run();
    const buyPreparation: SavedWarmupPreparation = {
      id: id(9001),
      planId: 'historical-receipts',
      planRevision: 1,
      cycle: 1,
      walletRevision: 1,
      createdAt: at(0),
      document: {
        ...unsignedPreparationSummary(b.order, b.simulation),
        inventory: null,
      },
    };
    const insertPreparation = async (saved: SavedWarmupPreparation) => {
      await db
        .prepare(
          'INSERT INTO warmup_swap_preparations(id,owner_id,plan_id,plan_revision,cycle,wallet_address,wallet_revision,document,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          saved.id,
          'owner',
          saved.planId,
          saved.planRevision,
          saved.cycle,
          saved.document.wallet,
          saved.walletRevision,
          JSON.stringify(saved.document),
          saved.createdAt,
        )
        .run();
    };
    const insertApproval = async (
      saved: SavedWarmupPreparation,
      fixture: typeof b,
      intentId: string,
      initial: number,
    ) => {
      const review = {
        id: intentId,
        preparationId: saved.id,
        wallet: fixture.wallet,
        network: 'mainnet',
        sha256: fixture.order.preparation.sha256,
        maximumFeeLamports: '5000',
        inputMint: fixture.order.inputMint,
        outputMint: fixture.order.outputMint,
        inputRaw: fixture.order.inAmount,
        minimumOutputRaw: fixture.order.minimumOutAmount,
        transaction: fixture.order.preparation.transaction,
        expiresAt: fixture.order.expiresAt,
      };
      await db
        .prepare(
          'INSERT INTO warmup_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .bind(
          intentId,
          'owner',
          saved.id,
          fixture.wallet,
          JSON.stringify(review),
          'awaiting_signature',
          at(initial),
          at(initial),
        )
        .run();
      await db
        .prepare(
          "UPDATE warmup_signing_intents SET signature=?,state='signed',updated_at=? WHERE owner_id=? AND id=?",
        )
        .bind(fixture.signed.signature, at(initial + 1), 'owner', intentId)
        .run();
      await db
        .prepare(
          "UPDATE warmup_signing_intents SET state='submitted',updated_at=? WHERE owner_id=? AND id=?",
        )
        .bind(at(initial + 2), 'owner', intentId)
        .run();
    };
    await insertPreparation(buyPreparation);
    await insertApproval(buyPreparation, b, id(9011), 0);
    const buyDocument = {
      ...(await decodeWarmupReceipt(
        b.receipt,
        buyPreparation,
        b.signed.signature,
        'Buy',
      )),
      observedAt: at(2),
      source: 'receipt-fixture.test',
    };
    const buy: SavedWarmupBuyReceipt = {
      id: id(9002),
      preparationId: buyPreparation.id,
      planId: buyPreparation.planId,
      planRevision: 1,
      cycle: 1,
      walletRevision: 1,
      createdAt: at(3),
      remainingRaw: buyDocument.acquiredRaw,
      document: buyDocument,
    };
    await db
      .prepare(
        'INSERT INTO warmup_buy_receipts(id,owner_id,preparation_id,plan_id,plan_revision,cycle,wallet_address,wallet_revision,signature,document,created_at,remaining_raw) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        buy.id,
        'owner',
        buy.preparationId,
        buy.planId,
        buy.planRevision,
        buy.cycle,
        b.wallet,
        buy.walletRevision,
        b.signed.signature,
        JSON.stringify(buy.document),
        buy.createdAt,
        buy.remainingRaw!,
      )
      .run();
    await db
      .prepare(
        "UPDATE warmup_signing_intents SET state='finalized',updated_at=? WHERE id=?",
      )
      .bind(at(3), id(9011))
      .run();
    const sellPreparation: SavedWarmupPreparation = {
      id: id(9003),
      planId: buy.planId,
      planRevision: 1,
      cycle: 1,
      walletRevision: 1,
      createdAt: at(4),
      document: {
        ...unsignedPreparationSummary(s.order, s.simulation),
        inventory: null,
        buyReceipt: {
          receiptId: buy.id,
          preparationId: buy.preparationId,
          signature: buy.document.signature,
          acquiredRaw: buy.document.acquiredRaw,
          decimals: buy.document.decimals,
          slot: buy.document.slot,
          preparationSha256: buy.document.preparationSha256,
          limitations: 'Synthetic retained matching buy.',
        },
      },
    };
    await insertPreparation(sellPreparation);
    await insertApproval(sellPreparation, s, id(9013), 4);
    const { acquiredRaw: consumedRaw, ...sellProof } =
      await decodeWarmupReceipt(
        s.receipt,
        sellPreparation,
        s.signed.signature,
        'Sell',
      );
    const sellReceipt = await saveWarmupSellReceipt(
      db,
      'owner',
      sellPreparation,
      buy,
      {
        ...sellProof,
        consumedRaw,
        buyReceiptId: buy.id,
        observedAt: at(7),
        source: 'receipt-fixture.test',
      },
    );
    expect(sellReceipt).not.toBeNull();
    const page = decodeOperationPage(
      await (await GET(request({ category: 'Warmup' }))).json(),
      projectId,
      'Warmup',
    );
    expect(page.records).toHaveLength(8);
    expect(
      page.records.filter((record) =>
        record.label.includes('Presently retained matching finalized'),
      ),
    ).toHaveLength(2);
    const finalizedBuy = page.records.find(
      (record) =>
        record.state === 'finalized' && record.label.startsWith('Warmup Buy'),
    )!;
    const finalizedSell = page.records.find(
      (record) =>
        record.state === 'finalized' && record.label.startsWith('Warmup Sell'),
    )!;
    expect(finalizedBuy.details.join(' ')).toContain(
      'Acquired 1000 atomic token units',
    );
    expect(finalizedSell.details.join(' ')).toContain(
      'Consumed 1000 atomic token units',
    );
    expect(finalizedSell.details.join(' ')).toContain(
      'SOL settlement 1000000 lamports',
    );
    expect(finalizedSell.signature).toBe(s.signed.signature);
    expect(
      page.records
        .filter((record) => record.state !== 'finalized')
        .every(
          (record) =>
            !record.details
              .join(' ')
              .includes('matching finalized buy receipt') &&
            !record.details
              .join(' ')
              .includes('matching finalized sell receipt'),
        ),
    ).toBe(true);
    expect(JSON.stringify(page)).not.toContain(b.order.preparation.transaction);
    expect(JSON.stringify(page)).not.toContain(s.order.preparation.transaction);
    expect(JSON.stringify(page)).not.toContain('remainingRaw');
    expect(
      await db
        .prepare(
          'SELECT remaining_raw AS remaining FROM warmup_buy_receipts WHERE owner_id=? AND id=?',
        )
        .bind('owner', buy.id)
        .first(),
    ).toEqual({ remaining: '0' });
    for (let n = 1; n <= 53; n++) {
      await db
        .prepare(
          "INSERT INTO warmup_signing_events(id,owner_id,intent_id,preparation_id,plan_id,plan_revision,cycle,wallet_address,type,state,signature,document,created_at,failure_receipt) SELECT ?,owner_id,intent_id,preparation_id,plan_id,plan_revision,cycle,wallet_address,'approval.baseline',state,signature,document,created_at,failure_receipt FROM warmup_signing_events WHERE owner_id=? AND preparation_id=? AND state='signed' ORDER BY sequence ASC LIMIT 1",
        )
        .bind(
          (n + 100).toString(16).padStart(32, '0'),
          'owner',
          buyPreparation.id,
        )
        .run();
    }
    const first = decodeOperationPage(
      await (await GET(request())).json(),
      projectId,
      'All',
    );
    expect(first.records).toHaveLength(50);
    const older = decodeOperationPage(
      await (await GET(request({ cursor: first.nextCursor! }))).json(),
      projectId,
      'All',
    );
    expect(
      new Set([...first.records, ...older.records].map((record) => record.key))
        .size,
    ).toBe(61);
    const mutate = async (document: Record<string, unknown>) => {
      await db
        .prepare(
          'UPDATE warmup_buy_receipts SET document=? WHERE owner_id=? AND id=?',
        )
        .bind(JSON.stringify(document), 'owner', buy.id)
        .run();
      const changed = decodeOperationPage(
        await (await GET(request({ category: 'Warmup' }))).json(),
        projectId,
        'Warmup',
      );
      const approval = changed.records.find(
        (record) => record.key === finalizedBuy.key,
      )!;
      expect(approval.state).toBe('finalized');
      expect(approval.label).toContain('Finalized approval recorded');
      expect(approval.details.join(' ')).toContain('contradicts');
    };
    await mutate({ ...buy.document, nativeSettlementRaw: '-999999' });
    await mutate({ ...buy.document, networkFeeLamports: '5001' });
    await mutate({ ...buy.document, observedAt: '2026-10-13T00:00:99.000Z' });
    await mutate({ ...buy.document, observedAt: at(9) });
    await mutate({ ...buy.document, observedAt: '2026-10-12T23:59:59.000Z' });
    await db
      .prepare(
        'UPDATE warmup_buy_receipts SET document=?,created_at=? WHERE owner_id=? AND id=?',
      )
      .bind(JSON.stringify(buy.document), at(9), 'owner', buy.id)
      .run();
    const future = decodeOperationPage(
      await (await GET(request({ category: 'Warmup' }))).json(),
      projectId,
      'Warmup',
    );
    expect(
      future.records.find((record) => record.key === finalizedBuy.key)?.label,
    ).toContain('Finalized approval recorded');
    await db
      .prepare(
        'UPDATE warmup_buy_receipts SET created_at=?,owner_id=? WHERE id=?',
      )
      .bind(buy.createdAt, 'other', buy.id)
      .run();
    const isolated = decodeOperationPage(
      await (await GET(request({ category: 'Warmup' }))).json(),
      projectId,
      'Warmup',
    );
    expect(
      isolated.records
        .find((record) => record.key === finalizedBuy.key)
        ?.details.join(' '),
    ).toContain('evidence is unavailable');
    expect(
      isolated.records
        .find((record) => record.key === finalizedSell.key)
        ?.details.join(' '),
    ).toContain('buy provenance is unavailable');
    await db.prepare('DROP TABLE warmup_buy_receipts').run();
    await db.prepare('DROP TABLE warmup_sell_receipts').run();
    const missing = decodeOperationPage(
      await (await GET(request({ category: 'Warmup' }))).json(),
      projectId,
      'Warmup',
    );
    expect(
      missing.records.find((record) => record.key === finalizedBuy.key)?.state,
    ).toBe('finalized');
    expect(
      missing.records.find((record) => record.key === finalizedSell.key)?.state,
    ).toBe('finalized');
    expect(missing.missingSources).not.toContain('warmup');
    expect(
      missing.records
        .filter((record) => record.state === 'finalized')
        .every((record) =>
          record.details.join(' ').includes('evidence is unavailable'),
        ),
    ).toBe(true);
    context.user = { userId: 'other' };
    expect((await GET(request({ category: 'Warmup' }))).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await mf.dispose();
  }
});
