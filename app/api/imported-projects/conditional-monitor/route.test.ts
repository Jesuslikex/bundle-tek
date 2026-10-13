import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import bs58 from 'bs58';
const mocks = vi.hoisted(() => ({
  user: null as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { GET, POST } from './route';
import { runConditionalMonitors } from '@/lib/conditional-monitor-server';
import { conditionalOrderTerms } from '@/lib/conditional-order';
import { decodeConditionalMonitorPage } from '@/lib/conditional-monitor';
const { unstable_splitSqlQuery: splitSql } = createRequire(import.meta.url)(
  'wrangler',
) as { unstable_splitSqlQuery: (sql: string) => string[] };
const mint = bs58.encode(new Uint8Array(32).fill(8)),
  wallet = bs58.encode(new Uint8Array(32).fill(7)),
  pool = bs58.encode(new Uint8Array(32).fill(6));
let mf: Miniflare, owner: string, projectId: string, buy: string, sell: string;
const request = (body: object) =>
  new Request('http://test/api/imported-projects/conditional-monitor', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const settings = (enabled = true, monitorRevision = 0) => ({
  projectId,
  projectRevision: 1,
  monitorRevision,
  enabled,
});
const page = async () =>
  decodeConditionalMonitorPage(
    await (
      await GET(
        new Request(
          'http://test/api/imported-projects/conditional-monitor?' +
            new URLSearchParams({ projectId }),
        ),
      )
    ).json(),
    projectId,
  );
async function seedOrder(
  side: 'Buy' | 'Sell',
  kind: 'limit' | 'grid' = 'limit',
) {
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  const terms = conditionalOrderTerms(
    {
      projectId,
      projectRevision: 1,
      wallet,
      walletRevision: 1,
      pair: pool,
      side,
      kind,
      direction: side === 'Buy' ? 'at-or-below' : 'at-or-above',
      amount: side === 'Buy' ? '0.000000011' : '2.5',
      ...(kind === 'grid'
        ? { minimumUsd: '50', maximumUsd: '100', lines: 3 }
        : { targetUsd: side === 'Buy' ? '100' : '50' }),
    },
    { chain: 'Solana', address: mint, decimals: 6 },
  );
  await mocks.db
    .prepare(
      "INSERT INTO conditional_sell_orders(id,owner_id,project_id,document,state,revision,created_at,updated_at) VALUES(?,?,?,?,'draft',1,?,?)",
    )
    .bind(id, owner, projectId, JSON.stringify(terms), now, now)
    .run();
  return id;
}
function provider(cap = 80) {
  return vi.fn(async () =>
    Response.json([
      {
        chainId: 'solana',
        dexId: 'raydium',
        pairAddress: pool,
        baseToken: { address: mint },
        quoteToken: {
          address: 'So11111111111111111111111111111111111111112',
          symbol: 'SOL',
        },
        marketCap: cap,
        priceUsd: '1',
        liquidity: { usd: 100000 },
      },
    ]),
  );
}
async function due() {
  await mocks.db
    .prepare(
      'UPDATE conditional_monitor_jobs SET next_check_at=0 WHERE owner_id=?',
    )
    .bind(owner)
    .run();
  await mocks.db
    .prepare('UPDATE market_read_gates SET next_allowed_at=0 WHERE owner_id=?')
    .bind(owner)
    .run();
}
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'conditional-monitor-tests',
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
          env: {
            DB: { type: 'd1', id: 'conditional-monitor-disposable-only' },
          },
        },
      },
    ],
  });
  mocks.db = await mf.getD1Database('DB', 'conditional-monitor-tests');
  const journal = JSON.parse(
    readFileSync('drizzle/meta/_journal.json', 'utf8'),
  ) as { entries: { tag: string }[] };
  expect(journal.entries).toHaveLength(74);
  for (const e of journal.entries) {
    const sql = readFileSync(`drizzle/${e.tag}.sql`, 'utf8');
    const statements = e.tag.startsWith('0073')
      ? splitSql(sql)
      : sql.split('--> statement-breakpoint').filter((s) => s.trim());
    if (e.tag.startsWith('0073')) expect(statements).toHaveLength(8);
    await mocks.db.batch(statements.map((s) => mocks.db.prepare(s)));
  }
});
afterAll(async () => {
  await mf?.dispose();
});
it('reports missing selected-pool coverage without fabricating a false-to-true crossing', async () => {
  await POST(request(settings()));
  await runConditionalMonitors(mocks.db, provider());
  await due();
  await runConditionalMonitors(
    mocks.db,
    vi.fn(async () => Response.json([])),
  );
  expect((await page()).monitor?.error).toBe('pool-unavailable');
  expect((await page()).notices).toHaveLength(1);
  await due();
  await runConditionalMonitors(mocks.db, provider());
  expect((await page()).notices).toHaveLength(1);
});
it('rejects a completion after its lease expires and retries without an old notice', async () => {
  await POST(request(settings()));
  const fetcher = vi.fn(async () => {
    await mocks.db
      .prepare(
        'UPDATE conditional_monitor_jobs SET lease_until=0 WHERE owner_id=?',
      )
      .bind(owner)
      .run();
    return provider()();
  });
  await runConditionalMonitors(mocks.db, fetcher);
  expect((await page()).notices).toHaveLength(0);
  expect((await page()).monitor?.error).toBe('context-changed');
});
it('allows only one concurrent worker to fetch and persist an owner/project sample', async () => {
  await POST(request(settings()));
  let release: (r: Response) => void = () => {},
    started: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const first = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
        started();
      }),
  );
  const second = provider();
  const run = runConditionalMonitors(mocks.db, first);
  await entered;
  expect((await runConditionalMonitors(mocks.db, second)).processed).toBe(0);
  expect(second).not.toHaveBeenCalled();
  release(await provider()());
  await run;
  expect((await page()).notices).toHaveLength(1);
});
it('withholds a stored notice that is not bound to an owned retained order', async () => {
  await POST(request(settings()));
  await runConditionalMonitors(mocks.db, provider());
  const p = await page();
  const forged = {
    ...p.notices[0],
    id: crypto.randomUUID(),
    matches: p.notices[0].matches.map((m) => ({
      ...m,
      orderId: crypto.randomUUID(),
    })),
  };
  await mocks.db
    .prepare(
      'INSERT INTO conditional_monitor_notices(id,owner_id,project_id,document,created_at) VALUES(?,?,?,?,?)',
    )
    .bind(
      forged.id,
      owner,
      projectId,
      JSON.stringify(forged),
      forged.observedAt,
    )
    .run();
  const response = await GET(
    new Request(
      'http://test/api/imported-projects/conditional-monitor?projectId=' +
        projectId,
    ),
  );
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain(forged.id);
});
it('pauses malformed persisted match state before provider work and allows an explicit repair request', async () => {
  await POST(request(settings()));
  await mocks.db
    .prepare(
      "UPDATE conditional_monitor_jobs SET match_keys='{}' WHERE owner_id=?",
    )
    .bind(owner)
    .run();
  const fetcher = provider();
  expect((await runConditionalMonitors(mocks.db, fetcher)).errors).toBe(1);
  expect(fetcher).not.toHaveBeenCalled();
  expect((await page()).monitor).toMatchObject({
    enabled: false,
    error: 'storage-unavailable',
  });
  expect((await POST(request(settings(true, 1)))).status).toBe(200);
});
beforeEach(async () => {
  vi.restoreAllMocks();
  owner = crypto.randomUUID();
  projectId = crypto.randomUUID();
  mocks.user = { userId: owner };
  await mocks.db.prepare('UPDATE conditional_monitor_jobs SET enabled=0').run();
  await mocks.db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,?,?,?,1,0,?,?)')
    .bind(
      owner,
      projectId,
      'Solana',
      mint,
      JSON.stringify({
        token: { chain: 'Solana', address: mint, decimals: 6 },
      }),
      crypto.randomUUID(),
      new Date().toISOString(),
    )
    .run();
  await mocks.db
    .prepare(
      'INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,label,role,revision,archived,updated_at) VALUES(?,?,?,?,?,?,1,0,?)',
    )
    .bind(
      owner,
      'Solana',
      wallet,
      '',
      'Fixture',
      'Recipient',
      new Date().toISOString(),
    )
    .run();
  buy = await seedOrder('Buy');
  sell = await seedOrder('Sell');
});
it('persists requests, samples both denominations without a browser, retains immutable notices and requires no execution', async () => {
  expect((await page()).monitor).toBeNull();
  expect((await POST(request(settings()))).status).toBe(200);
  const fetcher = provider();
  expect(await runConditionalMonitors(mocks.db, fetcher)).toMatchObject({
    processed: 1,
    errors: 0,
    executionAllowed: false,
  });
  const p = await page();
  expect(p.monitor?.enabled).toBe(true);
  expect(p.monitor?.lastCheckedAt).not.toBeNull();
  expect(p.notices).toHaveLength(1);
  expect(p.notices[0].matches.find((m) => m.orderId === buy)).toMatchObject({
    side: 'Buy',
    levels: [{ unitsRaw: '11' }],
  });
  expect(p.notices[0].matches.find((m) => m.orderId === sell)).toMatchObject({
    side: 'Sell',
    levels: [{ unitsRaw: '2500000' }],
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]).toHaveLength(2);
  for (const table of [
    'imported_swap_preparations',
    'imported_swap_signing_intents',
    'conditional_level_reservations',
    'conditional_level_fills',
  ])
    expect(
      await mocks.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n'),
    ).toBe(0);
  await expect(
    mocks.db
      .prepare(
        "UPDATE conditional_monitor_notices SET document='{}' WHERE id=?",
      )
      .bind(p.notices[0].id)
      .run(),
  ).rejects.toThrow('immutable');
  await expect(
    mocks.db
      .prepare('DELETE FROM conditional_monitor_notices WHERE id=?')
      .bind(p.notices[0].id)
      .run(),
  ).rejects.toThrow('retained');
});
it('suppresses repeated matched samples and records only levels entering a condition again', async () => {
  await POST(request(settings()));
  await runConditionalMonitors(mocks.db, provider());
  await due();
  await runConditionalMonitors(mocks.db, provider());
  expect((await page()).notices).toHaveLength(1);
  await due();
  await runConditionalMonitors(mocks.db, provider(120));
  await due();
  await runConditionalMonitors(mocks.db, provider());
  const p = await page();
  expect(p.notices).toHaveLength(2);
  expect(p.notices[0].matches.map((m) => m.orderId)).toEqual([buy]);
});
it('backs off transient provider failure without stopping or duplicating retained notices', async () => {
  await POST(request(settings()));
  await runConditionalMonitors(mocks.db, provider());
  await due();
  const fetcher = vi.fn(
    async () => new Response('provider error', { status: 502 }),
  );
  await runConditionalMonitors(mocks.db, fetcher);
  const p = await page();
  expect(p.monitor).toMatchObject({
    enabled: true,
    error: 'provider-unavailable',
  });
  expect(p.monitor!.nextCheckAt).toBeGreaterThan(Date.now() + 13000);
  expect(p.notices).toHaveLength(1);
  await due();
  await runConditionalMonitors(mocks.db, provider());
  expect((await page()).monitor?.error).toBeNull();
  expect((await page()).notices).toHaveLength(1);
});
it('shares the foreground owner rate gate, retaining notices and retrying without a provider read', async () => {
  await POST(request(settings()));
  await mocks.db
    .prepare('INSERT INTO market_read_gates VALUES(?,?)')
    .bind(owner, Date.now() + 15000)
    .run();
  const fetcher = provider();
  await runConditionalMonitors(mocks.db, fetcher);
  expect(fetcher).not.toHaveBeenCalled();
  expect((await page()).monitor).toMatchObject({
    enabled: true,
    error: 'rate-limited',
  });
});
it('does not save an in-flight sample after an explicit pause', async () => {
  await POST(request(settings()));
  let release: (response: Response) => void = () => {};
  let started: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const delayed = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
        started();
      }),
  );
  const run = runConditionalMonitors(mocks.db, delayed);
  await entered;
  expect((await POST(request(settings(false, 1)))).status).toBe(200);
  release(await provider()());
  await run;
  const p = await page();
  expect(p.monitor).toMatchObject({ enabled: false, revision: 2 });
  expect(p.notices).toHaveLength(0);
  expect(
    await mocks.db
      .prepare(
        'SELECT COUNT(*) AS n FROM imported_market_observations WHERE owner_id=?',
      )
      .bind(owner)
      .first('n'),
  ).toBe(0);
});
it('keeps an active lease exclusive and recovers an expired crashed-worker lease', async () => {
  await POST(request(settings()));
  await mocks.db
    .prepare(
      'UPDATE conditional_monitor_jobs SET lease_token=?,lease_until=? WHERE owner_id=?',
    )
    .bind(crypto.randomUUID(), Date.now() + 20000, owner)
    .run();
  const fetcher = provider();
  expect((await runConditionalMonitors(mocks.db, fetcher)).processed).toBe(0);
  await mocks.db
    .prepare(
      'UPDATE conditional_monitor_jobs SET lease_until=0 WHERE owner_id=?',
    )
    .bind(owner)
    .run();
  expect((await runConditionalMonitors(mocks.db, fetcher)).processed).toBe(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('blocks cancelled-order drift during the provider read without retaining a stale match', async () => {
  await POST(request(settings()));
  const fetcher = vi.fn(async () => {
    await mocks.db
      .prepare(
        "UPDATE conditional_sell_orders SET state='cancelled',revision=2,updated_at=? WHERE owner_id=? AND id=?",
      )
      .bind(new Date().toISOString(), owner, buy)
      .run();
    return provider()();
  });
  await runConditionalMonitors(mocks.db, fetcher);
  expect((await page()).notices).toHaveLength(0);
  expect((await page()).monitor?.error).toBe('context-changed');
});
it('stops archived project monitoring before provider work while retaining owned history', async () => {
  await POST(request(settings()));
  await runConditionalMonitors(mocks.db, provider());
  await due();
  await mocks.db
    .prepare(
      'UPDATE imported_token_projects SET archived=1,revision=2,updated_at=? WHERE owner_id=? AND id=?',
    )
    .bind(new Date().toISOString(), owner, projectId)
    .run();
  const fetcher = provider();
  await runConditionalMonitors(mocks.db, fetcher);
  expect(fetcher).not.toHaveBeenCalled();
  expect((await page()).monitor).toMatchObject({
    enabled: false,
    error: 'context-changed',
  });
  expect((await page()).notices).toHaveLength(1);
});
it('scopes history and writes by authenticated owner and rejects stale configuration', async () => {
  await POST(request(settings()));
  expect((await POST(request(settings(true, 0)))).status).toBe(409);
  mocks.user = { userId: 'other' };
  expect(
    (
      await GET(
        new Request(
          'http://test/api/imported-projects/conditional-monitor?projectId=' +
            projectId,
        ),
      )
    ).status,
  ).toBe(404);
  expect((await POST(request(settings()))).status).toBe(404);
  mocks.user = null;
  expect((await POST(request(settings()))).status).toBe(401);
});
it('rejects cross-origin, malformed settings and unsupported automatic execution requests', async () => {
  const cross = request(settings());
  cross.headers.set('origin', 'https://foreign.test');
  expect((await POST(cross)).status).toBe(403);
  expect((await POST(request({ ...settings(), autoSign: true }))).status).toBe(
    400,
  );
  expect((await POST(request({ ...settings(), enabled: 1 }))).status).toBe(400);
});
it('makes the market save and notice append atomic when notice persistence fails', async () => {
  await POST(request(settings()));
  await mocks.db
    .prepare(
      `CREATE TRIGGER test_monitor_write_failure BEFORE INSERT ON conditional_monitor_notices WHEN NEW.owner_id='${owner}' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END;`,
    )
    .run();
  try {
    await runConditionalMonitors(mocks.db, provider());
    expect((await page()).notices).toHaveLength(0);
    expect((await page()).monitor?.lastCheckedAt).toBeNull();
    expect((await page()).monitor?.error).toBe('storage-unavailable');
    expect(
      await mocks.db
        .prepare(
          'SELECT COUNT(*) AS n FROM imported_market_observations WHERE owner_id=?',
        )
        .bind(owner)
        .first('n'),
    ).toBe(0);
  } finally {
    await mocks.db.prepare('DROP TRIGGER test_monitor_write_failure').run();
  }
});
