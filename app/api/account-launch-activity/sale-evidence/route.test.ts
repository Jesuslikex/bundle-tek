import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { importedSaleEvidenceFixture } from '../../../../test/imported-sale-evidence-fixture';
import type { readOwnedImportedSaleEvidence } from '@/lib/imported-sale-evidence-service';
type Summary = Awaited<ReturnType<typeof readOwnedImportedSaleEvidence>>;
const m = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({ getChatGPTUser: async () => m.user }));
vi.mock('@/db', () => ({ getD1: () => m.db }));
vi.mock('@/lib/solana-rpc', async (original) => ({
  ...(await original<typeof import('@/lib/solana-rpc')>()),
  getSolanaRpcEndpoint: () => 'https://sale-evidence.test',
}));
vi.mock('@/lib/wallet-rpc-pacing', () => ({
  paceWalletRpc: vi.fn(async () => {}),
}));
import { GET, POST } from './route';
let f: Awaited<ReturnType<typeof importedSaleEvidenceFixture>>;
const databases: DatabaseSync[] = [];
beforeAll(async () => {
  f = await importedSaleEvidenceFixture(true);
});
afterEach(() => {
  for (const d of databases.splice(0)) d.close();
  m.user = { userId: 'alice' };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
// Real tables and 0115 triggers. Finalized parents are synthetic, explicitly
// seeded; this does not exercise historical signing admission or chain calls.
function database(install = true) {
  const sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  for (const name of [
    '0041_imported_swap_preparations',
    '0047_shared_swap_reservations',
  ])
    for (const sql of readFileSync(`drizzle/${name}.sql`, 'utf8').split(
      '--> statement-breakpoint',
    ))
      if (/^\s*CREATE (?:TABLE|(?:UNIQUE )?INDEX)\s/.test(sql))
        sqlite.exec(sql);
  sqlite.exec(
    'CREATE TABLE imported_token_project_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER NOT NULL)',
  );
  const p = structuredClone(f.p),
    date = new Date().toISOString();
  sqlite
    .prepare('INSERT INTO imported_swap_preparations VALUES(?,?,?,?,?,?,?,?)')
    .run(
      p.preparationId,
      p.ownerId,
      p.projectId,
      1,
      p.wallet,
      1,
      p.preparationDocument,
      date,
    );
  sqlite
    .prepare(
      'INSERT INTO imported_swap_signing_intents VALUES(?,?,?,?,?,?,?,?,?)',
    )
    .run(
      p.intentId,
      p.ownerId,
      p.preparationId,
      p.wallet,
      p.approvalDocument,
      'finalized',
      p.signature,
      date,
      date,
    );
  sqlite
    .prepare('INSERT INTO imported_swap_receipts VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(
      p.receiptId,
      p.ownerId,
      p.intentId,
      p.preparationId,
      p.projectId,
      1,
      1,
      p.signature,
      p.receiptDocument,
      date,
    );
  sqlite
    .prepare('INSERT INTO solana_swap_signatures VALUES(?,?,?,?)')
    .run(p.ownerId, p.signature, 'imported', p.intentId);
  if (install)
    sqlite.exec(
      readFileSync('drizzle/0115_imported_sale_receipt_evidence.sql', 'utf8'),
    );
  const hooks: { afterInsert?: () => void } = {};
  m.db = {
    prepare(sql: string) {
      let values: SQLInputValue[] = [];
      return {
        bind(...v: SQLInputValue[]) {
          values = v;
          return this;
        },
        async first() {
          return sqlite.prepare(sql).get(...values) ?? null;
        },
        async run() {
          const result = sqlite.prepare(sql).run(...values);
          if (sql.startsWith('INSERT INTO imported_sale_receipt_evidence'))
            hooks.afterInsert?.();
          return { meta: { changes: Number(result.changes) } };
        },
      };
    },
  } as unknown as D1Database;
  return {
    sqlite,
    p,
    hooks,
    count: () =>
      Number(
        sqlite
          .prepare('SELECT count(*) AS n FROM imported_sale_receipt_evidence')
          .get()!.n,
      ),
  };
}
const url = 'https://bundle.example/api/account-launch-activity/sale-evidence';
const get = (id = f.p.receiptId) =>
  GET(new Request(`${url}?saleReceiptId=${id}`));
const post = (
  value: unknown = { saleReceiptId: f.p.receiptId },
  headers: Record<string, string> = {
    origin: 'https://bundle.example',
    'content-type': 'application/json',
  },
) =>
  POST(
    new Request(url, {
      method: 'POST',
      headers,
      body: typeof value === 'string' ? value : JSON.stringify(value),
    }),
  );
function provider() {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      if (typeof init.body !== 'string') throw Error('Expected JSON RPC body');
      const request = JSON.parse(init.body) as {
        method: string;
        params: unknown[];
      };
      calls.push(request.method);
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: await f.rpc(request.method, request.params, init.signal!),
      });
    }),
  );
  return calls;
}
it('captures with real storage and transport, reloads and retries without RPC or private packets', async () => {
  const d = database(),
    calls = provider();
  expect((await get()).status).toBe(200);
  expect(((await (await get()).json()) as Summary).entry).toBeNull();
  expect(calls).toEqual([]);
  const response = await post();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const saved = (await response.json()) as Summary;
  expect(saved.entry).toMatchObject({
    tokenUnitsRaw: '1000',
    nativeSettlementRaw: '1000000',
    executionAllowed: false,
    profitCalculated: false,
  });
  expect(calls).toEqual(['getGenesisHash', 'getTransaction']);
  expect(d.count()).toBe(1);
  expect(JSON.stringify(saved)).not.toContain(f.raw.transaction[0]);
  expect(Object.keys(saved).sort()).toEqual([
    'entry',
    'mint',
    'receiptId',
    'wallet',
  ]);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No provider after retention');
    }),
  );
  expect(await (await get()).json()).toEqual(saved);
  expect(await (await post()).json()).toEqual(saved);
  expect(d.count()).toBe(1);
});
it('refuses foreign ownership and Buy sources before any RPC or throttle write', async () => {
  const d = database(),
    calls = provider();
  m.user = { userId: 'bob' };
  expect((await get()).status).toBe(404);
  expect((await post()).status).toBe(404);
  m.user = { userId: 'alice' };
  d.sqlite
    .prepare('UPDATE imported_swap_receipts SET document=?')
    .run(d.p.receiptDocument.replace('"side":"Sell"', '"side":"Buy"'));
  expect((await post()).status).toBe(503);
  expect(calls).toEqual([]);
  expect(d.count()).toBe(0);
  expect(
    d.sqlite
      .prepare('SELECT count(*) AS n FROM imported_token_project_gates')
      .get()!.n,
  ).toBe(0);
});
it('requires auth, same origin, bounded JSON and one exact ID before provider access', async () => {
  database();
  const calls = provider();
  m.user = null;
  expect((await get()).status).toBe(401);
  expect((await post()).status).toBe(401);
  m.user = { userId: 'alice' };
  expect(
    (
      await post(undefined, {
        origin: 'https://elsewhere.example',
        'content-type': 'application/json',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await post(undefined, {
        origin: 'https://bundle.example',
        'content-type': 'text/plain',
      })
    ).status,
  ).toBe(415);
  for (const bad of [
    {},
    [],
    { saleReceiptId: f.p.receiptId, url: 'https://evil.example' },
    { saleReceiptId: 'invalid' },
    '{bad',
  ])
    expect((await post(bad)).status).toBe(400);
  expect((await post(' '.repeat(1025))).status).toBe(413);
  for (const query of [
    '',
    `?saleReceiptId=${f.p.receiptId}&saleReceiptId=${f.p.receiptId}`,
    `?saleReceiptId=${f.p.receiptId}&extra=1`,
  ])
    expect((await GET(new Request(url + query))).status).toBe(400);
  expect(calls).toEqual([]);
});
it('fails closed on missing schema, wrong network, rate limit and unavailable receipt, without retry', async () => {
  database(false);
  const calls = provider();
  expect((await post()).status).toBe(503);
  expect(calls).toEqual([]);
  for (const mode of ['genesis', '429', 'null']) {
    database();
    const methods: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: unknown, init: RequestInit) => {
        if (typeof init.body !== 'string')
          throw Error('Expected JSON RPC body');
        const q = JSON.parse(init.body) as {
          method: string;
          params: unknown[];
        };
        methods.push(q.method);
        if (mode === '429') return new Response('', { status: 429 });
        return Response.json({
          jsonrpc: '2.0',
          id: 1,
          result:
            q.method === 'getGenesisHash'
              ? mode === 'genesis'
                ? 'wrong'
                : await f.rpc(q.method, q.params, init.signal!)
              : null,
        });
      }),
    );
    const r = await post();
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await r.json())).not.toMatch(
      /sale-evidence\.test|SQL|access.key/,
    );
    expect(methods).toEqual(
      mode === 'null'
        ? ['getGenesisHash', 'getTransaction']
        : ['getGenesisHash'],
    );
  }
});
it('recovers committed capture after its response is lost, without a second RPC', async () => {
  const d = database(),
    calls = provider();
  d.hooks.afterInsert = () => {
    throw Error('Lost insert response');
  };
  const r = await post();
  expect(r.status).toBe(200);
  expect(d.count()).toBe(1);
  expect(calls).toHaveLength(2);
  expect((await get()).status).toBe(200);
  expect(calls).toHaveLength(2);
});
it('reloads committed evidence after cancellation without recapturing or disclosing private bytes', async () => {
  const d = database(),
    calls = provider(),
    c = new AbortController();
  d.hooks.afterInsert = () => c.abort();
  const response = await POST(
    new Request(url, {
      method: 'POST',
      headers: {
        origin: 'https://bundle.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ saleReceiptId: f.p.receiptId }),
      signal: c.signal,
    }),
  );
  expect(response.status).toBe(408);
  expect(d.count()).toBe(1);
  const saved = await get();
  expect(saved.status).toBe(200);
  expect(((await saved.json()) as Summary).entry).not.toBeNull();
  expect(calls).toEqual(['getGenesisHash', 'getTransaction']);
});
it('does not bypass the retained service throttle after a failed capture', async () => {
  const d = database();
  const fetcher = vi.fn(async () => new Response('', { status: 429 }));
  vi.stubGlobal('fetch', fetcher);
  expect((await post()).status).toBe(503);
  expect((await post()).status).toBe(429);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(d.count()).toBe(0);
});
it('enforces the body deadline without waiting for an uncooperative stream', async () => {
  const d = database(),
    calls = provider();
  let timed!: () => void;
  const began = new Promise<void>((r) => {
    timed = r;
  });
  const timeout = new AbortController();
  const native = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) =>
    ms === 5000 ? timeout.signal : native(ms),
  );
  const request = new Request(url, {
    method: 'POST',
    headers: {
      origin: 'https://bundle.example',
      'content-type': 'application/json',
    },
    body: new ReadableStream({
      pull() {
        timed();
        return new Promise(() => {});
      },
    }),
    duplex: 'half',
  } as RequestInit);
  const response = POST(request);
  await began;
  timeout.abort(new DOMException('Timed out', 'TimeoutError'));
  expect((await response).status).toBe(408);
  expect(calls).toEqual([]);
  expect(d.count()).toBe(0);
});
it('aborts a stalled request body before provider access or capture', async () => {
  const d = database(),
    calls = provider();
  const c = new AbortController();
  const request = new Request(url, {
    method: 'POST',
    headers: {
      origin: 'https://bundle.example',
      'content-type': 'application/json',
    },
    body: new ReadableStream({ pull: () => new Promise(() => {}) }),
    duplex: 'half',
    signal: c.signal,
  } as RequestInit);
  const r = POST(request);
  await Promise.resolve();
  c.abort();
  expect((await r).status).toBe(408);
  expect(calls).toEqual([]);
  expect(d.count()).toBe(0);
});
it('cancels an uncooperative RPC promptly and never retains late data', async () => {
  const d = database();
  let started!: () => void;
  const began = new Promise<void>((r) => {
    started = r;
  });
  let resolve!: (r: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      started();
      return new Promise<Response>((r) => {
        resolve = r;
      });
    }),
  );
  const c = new AbortController(),
    r = POST(
      new Request(url, {
        method: 'POST',
        headers: {
          origin: 'https://bundle.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ saleReceiptId: f.p.receiptId }),
        signal: c.signal,
      }),
    );
  await began;
  c.abort();
  expect((await r).status).toBe(408);
  expect(d.count()).toBe(0);
  resolve(Response.json({ jsonrpc: '2.0', id: 1, result: 'late' }));
  await new Promise((r) => setTimeout(r, 0));
  expect(d.count()).toBe(0);
});
