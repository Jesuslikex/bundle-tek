import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { validateFunding } from '@/lib/funding-plan';
const mocks = vi.hoisted(() => ({
  user: null as { userId: string; email: string } | null,
  db: null as unknown as D1Database,
  fees: vi.fn(),
  prepare: vi.fn(),
  prepareSolana: vi.fn(),
  prepareToken: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/funding-fees', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/funding-fees')>()),
  reviewFundingFees: mocks.fees,
}));
vi.mock('@/lib/funding-transactions', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/funding-transactions')>();
  return { ...actual, prepareUnsignedFunding: mocks.prepare };
});
import { POST as feePOST } from './fees/route';
vi.mock('@/lib/solana-funding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/solana-funding')>()),
  prepareSolanaFunding: mocks.prepareSolana,
}));
vi.mock('@/lib/solana-token-funding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/solana-token-funding')>()),
  prepareSolanaTokenFunding: mocks.prepareToken,
}));
import { GET, POST } from './route';
import { GET as eventsGET } from './events/route';
let mf: Miniflare;
const input = () => ({
  name: 'Treasury schedule',
  chain: 'Solana',
  currency: 'SOL',
  source: 'Manual',
  sourceLabel: 'Treasury',
  funderAddress: '',
  startAt: new Date(Date.now() + 300000).toISOString(),
  delaySeconds: 10,
  recipients: [
    {
      address: 'So11111111111111111111111111111111111111112',
      amount: '0.100000001',
    },
    { address: '11111111111111111111111111111111', amount: '0.2' },
  ],
});
const post = (overrides = {}, headers = {}) =>
  POST(
    new Request('http://localhost/api/funding', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        id: 'plan-a',
        expectedRevision: 0,
        action: 'save',
        document: input(),
        ...overrides,
      }),
    }),
  );
const history = (cursor = '') =>
  eventsGET(
    new Request(
      'http://localhost/api/funding/events' +
        (cursor ? '?cursor=' + cursor : ''),
    ),
  );
const read = async (response: Response) =>
  (await response.json()) as {
    plans: {
      revision: number;
      document: ReturnType<typeof validateFunding>;
      archived: boolean;
    }[];
    events: { id: number; type: string }[];
    nextCursor: string | null;
  };
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'funding-test',
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
          env: { DB: { type: 'd1', id: 'funding-test-only' } },
        },
      },
    ],
  });
  mocks.db = (await mf.getD1Database(
    'DB',
    'funding-test',
  )) as unknown as D1Database;
  for (const sql of readFileSync(
    new URL('../../../drizzle/0007_superb_iron_monger.sql', import.meta.url),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
  for (const sql of readFileSync(
    new URL('../../../drizzle/0152_funding_save_stops.sql', import.meta.url),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
  for (const sql of readFileSync(
    new URL('../../../drizzle/0012_messy_zzzax.sql', import.meta.url),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
}, 30000);
beforeEach(async () => {
  mocks.user = { userId: 'alice', email: 'alice@example.test' };
  mocks.fees.mockReset();
  mocks.prepare.mockReset();
  mocks.prepareSolana.mockReset();
  mocks.prepareToken.mockReset();
  await mocks.db.batch([
    mocks.db.prepare('DELETE FROM funding_events'),
    mocks.db.prepare('DELETE FROM funding_plans'),
    mocks.db.prepare('DELETE FROM wallet_balance_gates'),
  ]);
});
afterAll(async () => {
  await mf?.dispose();
});
describe('saved funding plans on real D1', () => {
  it('opens one owned funding draft at its latest revision including archived records', async () => {
    await post();
    await post({ action: 'archive', expectedRevision: 1 });
    const request = new Request('http://localhost/api/funding?id=plan-a');
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      plan: {
        id: 'plan-a',
        revision: 2,
        archived: true,
        document: { total: '0.300000001' },
      },
    });
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await GET(request)).status).toBe(404);
    mocks.user = null;
    expect((await GET(request)).status).toBe(401);
  });
  it('rejects malformed targeted reads and reports a missing draft without returning the full account list', async () => {
    await post();
    for (const id of ['', 'bad/id', 'x'.repeat(65)])
      expect(
        (
          await GET(
            new Request(
              `http://localhost/api/funding?id=${encodeURIComponent(id)}`,
            ),
          )
        ).status,
      ).toBe(400);
    const missing = await GET(
      new Request('http://localhost/api/funding?id=missing'),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: 'Saved funding draft not found.',
    });
    expect(
      (await read(await GET(new Request('http://localhost:3000/api/funding'))))
        .plans,
    ).toHaveLength(1);
  });
  it('preserves exact amounts and derives recipient times from delay', () => {
    const value = input(),
      doc = validateFunding(value);
    expect(doc.total).toBe('0.300000001');
    expect(
      Date.parse(doc.items[1].scheduledAt) -
        Date.parse(doc.items[0].scheduledAt),
    ).toBe(10000);
    expect(doc.items[0].scheduledAt).toBe(value.startAt);
    expect(() => validateFunding({ ...value, currency: 'USDC' })).toThrow(
      '6 decimal',
    );
    expect(() =>
      validateFunding({
        ...value,
        recipients: [value.recipients[0], value.recipients[0]],
      }),
    ).toThrow('once');
    expect(() =>
      validateFunding({
        ...value,
        recipients: [{ ...value.recipients[0], amount: '0' }],
      }),
    ).toThrow('greater');
    expect(() => validateFunding({ ...value, delaySeconds: 0.5 })).toThrow(
      'whole',
    );
  });
  it('uses exact asset identity and captured precision rather than a shared symbol', () => {
    const document = validateFunding({
      ...input(),
      chain: 'BNB',
      currency: 'USDC',
      assetAddress: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
      recipients: [
        {
          address: '0x1111111111111111111111111111111111111111',
          amount: '0.123456789012345678',
        },
      ],
    });
    expect(document.total).toBe('0.123456789012345678');
    expect(document.assetAddress).toBe(
      '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    );
    expect(() =>
      validateFunding({ ...document, assetAddress: undefined }),
    ).toThrow('Unsupported');
    expect(() => validateFunding({ ...document, currency: 'BNB' })).toThrow(
      'matching',
    );
    expect(() => validateFunding({ ...document, chain: 'Base' })).toThrow(
      'matching',
    );
    expect(() =>
      validateFunding({ ...document, assetAddress: 'unknown' }),
    ).toThrow('matching');
  });
  it('persists asset identity with exact amounts and preserves prior document/history on an invalid asset', async () => {
    const document = {
      ...input(),
      chain: 'BNB',
      currency: 'USDC',
      assetAddress: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
      recipients: [
        {
          address: '0x1111111111111111111111111111111111111111',
          amount: '0.123456789012345678',
        },
      ],
    };
    expect((await post({ document })).status).toBe(200);
    const before = await read(
      await GET(new Request('http://localhost:3000/api/funding')),
    );
    expect(before.plans[0].document).toMatchObject({
      assetAddress: document.assetAddress,
      total: '0.123456789012345678',
    });
    expect(
      (
        await post({
          expectedRevision: 1,
          document: {
            ...document,
            assetAddress: '0x2222222222222222222222222222222222222222',
          },
        })
      ).status,
    ).toBe(400);
    expect(
      await read(await GET(new Request('http://localhost:3000/api/funding'))),
    ).toEqual(before);
    expect((await read(await history())).events).toHaveLength(1);
  });
  it('enforces authentication, same origin and JSON', async () => {
    mocks.user = null;
    expect(
      (await GET(new Request('http://localhost:3000/api/funding'))).status,
    ).toBe(401);
    expect((await history()).status).toBe(401);
    expect((await post()).status).toBe(401);
    mocks.user = { userId: 'alice', email: 'a@b.test' };
    expect((await post({}, { origin: 'https://foreign.example' })).status).toBe(
      403,
    );
    expect((await post({}, { 'content-type': 'text/plain' })).status).toBe(415);
    expect(
      (await GET(new Request('http://localhost:3000/api/funding'))).headers.get(
        'cache-control',
      ),
    ).toBe('no-store');
  });
  it('saves actual history through update, archive and restore', async () => {
    expect((await post()).status).toBe(200);
    expect(
      (
        await post({
          expectedRevision: 1,
          document: { ...input(), name: 'Changed' },
        })
      ).status,
    ).toBe(200);
    expect(
      (await post({ action: 'archive', expectedRevision: 2 })).status,
    ).toBe(200);
    expect((await post({ action: 'save', expectedRevision: 3 })).status).toBe(
      409,
    );
    expect(
      (await post({ action: 'restore', expectedRevision: 3 })).status,
    ).toBe(200);
    const rows = await read(
      await GET(new Request('http://localhost:3000/api/funding')),
    );
    expect(rows.plans[0].revision).toBe(4);
    expect(rows.plans[0].document.name).toBe('Changed');
    expect(rows.plans[0].archived).toBe(false);
    expect((await read(await history())).events.map((e) => e.type)).toEqual([
      'funding.restored',
      'funding.archived',
      'funding.updated',
      'funding.created',
    ]);
  });
  it('isolates owners even when IDs coincide', async () => {
    await post();
    mocks.user = { userId: 'bob', email: 'b@b.test' };
    expect(
      (await read(await GET(new Request('http://localhost:3000/api/funding'))))
        .plans,
    ).toEqual([]);
    expect((await read(await history())).events).toEqual([]);
    expect((await post({ expectedRevision: 1 })).status).toBe(409);
    expect((await post()).status).toBe(200);
    expect((await read(await history())).events).toHaveLength(1);
  });
  it('admits one concurrent revision without emitting a false event', async () => {
    await post();
    const results = await Promise.all([
      post({ expectedRevision: 1 }),
      post({ expectedRevision: 1 }),
    ]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    expect((await read(await history())).events).toHaveLength(2);
    expect(
      (await read(await GET(new Request('http://localhost:3000/api/funding'))))
        .plans[0].revision,
    ).toBe(2);
  });
  it('rolls back the plan mutation when event storage fails', async () => {
    await post();
    await mocks.db
      .prepare('ALTER TABLE funding_events RENAME TO funding_events_hidden')
      .run();
    try {
      expect((await post({ expectedRevision: 1 })).status).toBe(503);
      expect(
        (
          await read(
            await GET(new Request('http://localhost:3000/api/funding')),
          )
        ).plans[0].revision,
      ).toBe(1);
    } finally {
      await mocks.db
        .prepare('ALTER TABLE funding_events_hidden RENAME TO funding_events')
        .run();
    }
  });
  it('rejects invalid inputs before writing any plan or event', async () => {
    expect(
      (
        await post({
          document: {
            ...input(),
            recipients: [{ address: 'private-key-not-accepted', amount: '1' }],
          },
        })
      ).status,
    ).toBe(400);
    expect((await post({ action: 'execute' })).status).toBe(400);
    expect(
      (await read(await GET(new Request('http://localhost:3000/api/funding'))))
        .plans,
    ).toEqual([]);
    expect((await read(await history())).events).toEqual([]);
  });
  it('pages history without duplicate events and rejects invalid cursors', async () => {
    await mocks.db
      .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<55)
        INSERT INTO funding_events (owner_id,plan_id,name,chain,type,revision,created_at)
        SELECT 'alice','plan-a','Schedule','Solana','funding.updated',i,? FROM n`)
      .bind(new Date().toISOString())
      .run();
    const first = await read(await history());
    expect(first.events).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await read(await history(first.nextCursor!));
    expect(second.events).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.events, ...second.events].map((e) => e.id)).size,
    ).toBe(55);
    expect((await history('-1')).status).toBe(400);
  });
  it('enforces the plan limit including archived drafts', async () => {
    await mocks.db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100) INSERT INTO funding_plans (owner_id,id,document,revision,archived,mutation_id,updated_at) SELECT 'alice', 'seed-'||i, ?, 1, 1, 'seed', ? FROM n`,
      )
      .bind(JSON.stringify(validateFunding(input())), new Date().toISOString())
      .run();
    expect((await post()).status).toBe(409);
    expect((await read(await history())).events).toEqual([]);
  });
});

describe('owner-scoped saved funding fee reviews', () => {
  const request = (revision = 1, action = 'review') =>
    feePOST(
      new Request('http://localhost/api/funding/fees', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'plan-a', revision, action }),
      }),
    );
  it('dispatches exact Solana token assets to token preparation and binds the saved revision', async () => {
    const document = {
      ...input(),
      currency: 'USDC',
      assetAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      recipients: [
        { address: input().recipients[0].address, amount: '0.123456' },
      ],
    };
    expect((await post({ document })).status).toBe(200);
    mocks.prepareToken.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      currency: 'USDC',
      signed: false,
      executionAllowed: false,
    });
    const response = await request(1, 'prepare-solana');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: 'plan-a',
      revision: 1,
      batch: { currency: 'USDC', signed: false },
    });
    expect(mocks.prepareToken.mock.calls[0][0]).toMatchObject({
      assetAddress: document.assetAddress,
      total: '0.123456',
    });
    expect(mocks.prepareSolana).not.toHaveBeenCalled();
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    mocks.prepareToken.mockImplementation(async () => {
      await mocks.db
        .prepare('UPDATE funding_plans SET revision=revision+1')
        .run();
      return { expiresAt: new Date(Date.now() + 60000).toISOString() };
    });
    expect((await request(1, 'prepare-solana')).status).toBe(409);
  });
  it('prepares SOL only for the current owner and revision with the shared throttle and no new history', async () => {
    await post();
    mocks.prepareSolana.mockResolvedValue({
      signed: false,
      executionAllowed: false,
      chain: 'Solana',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      transactions: [],
    });
    expect((await request(2, 'prepare-solana')).status).toBe(409);
    expect(mocks.prepareSolana).not.toHaveBeenCalled();
    const response = await request(1, 'prepare-solana');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: 'plan-a',
      revision: 1,
      batch: { signed: false, executionAllowed: false, chain: 'Solana' },
    });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect((await request()).status).toBe(429);
    expect((await read(await history())).events).toHaveLength(1);
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await request(1, 'prepare-solana')).status).toBe(404);
    mocks.user = null;
    expect((await request(1, 'prepare-solana')).status).toBe(401);
  });
  it('withholds SOL preparation after revision changes, expiry or archive and redacts provider errors', async () => {
    await post();
    const batch = { expiresAt: new Date(Date.now() + 60000).toISOString() };
    mocks.prepareSolana.mockImplementation(async () => {
      await mocks.db
        .prepare('UPDATE funding_plans SET revision=revision+1')
        .run();
      return batch;
    });
    expect((await request(1, 'prepare-solana')).status).toBe(409);
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    mocks.prepareSolana.mockResolvedValue({
      ...batch,
      expiresAt: '2000-01-01',
    });
    expect((await request(2, 'prepare-solana')).status).toBe(409);
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    mocks.prepareSolana.mockRejectedValue(new Error('secret provider key'));
    const response = await request(2, 'prepare-solana');
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('secret');
    await mocks.db.prepare('UPDATE funding_plans SET archived=1').run();
    expect((await request(2, 'prepare-solana')).status).toBe(404);
  });
  it('requires an active exact revision and shares the wallet-read throttle without adding funding history', async () => {
    await post();
    mocks.fees.mockResolvedValue({ fixture: 'review' });
    expect((await request(2)).status).toBe(409);
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(429);
    expect((await read(await history())).events).toHaveLength(1);
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await request()).status).toBe(404);
    mocks.user = null;
    expect((await request()).status).toBe(401);
  });
  it('rejects a revision changed during provider reads and sanitizes provider failure', async () => {
    await post();
    mocks.fees.mockImplementation(async () => {
      await mocks.db
        .prepare('UPDATE funding_plans SET revision=revision+1')
        .run();
      return {};
    });
    expect((await request()).status).toBe(409);
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    mocks.fees.mockRejectedValue(new Error('secret endpoint'));
    const failed = await request(2);
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain('secret');
  });
  it('prepares only an owned active exact revision and adds no funding history or signature', async () => {
    await post();
    mocks.prepare.mockResolvedValue({
      version: 1,
      signed: false,
      executionAllowed: false,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      review: { fixture: 'prepared review' },
      transactions: [],
    });
    expect((await request(2, 'prepare')).status).toBe(409);
    expect(mocks.prepare).not.toHaveBeenCalled();
    const prepared = await request(1, 'prepare');
    expect(prepared.status).toBe(200);
    expect(await prepared.json()).toMatchObject({
      id: 'plan-a',
      revision: 1,
      batch: { signed: false, executionAllowed: false },
    });
    expect(mocks.fees).not.toHaveBeenCalled();
    expect((await request(1, 'prepare')).status).toBe(429);
    expect((await read(await history())).events).toHaveLength(1);
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await request(1, 'prepare')).status).toBe(404);
  });
  it('withholds prepared payloads on mid-read revision changes, archive and expiry, and hides provider details', async () => {
    await post();
    const batch = {
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      review: {},
    };
    mocks.prepare.mockImplementation(async () => {
      await mocks.db
        .prepare('UPDATE funding_plans SET revision=revision+1')
        .run();
      return batch;
    });
    expect((await request(1, 'prepare')).status).toBe(409);
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    mocks.prepare.mockResolvedValue({ ...batch, expiresAt: '2000-01-01' });
    expect((await request(2, 'prepare')).status).toBe(409);
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    mocks.prepare.mockRejectedValue(new Error('secret endpoint'));
    const failed = await request(2, 'prepare');
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain('secret');
    await mocks.db.prepare('UPDATE funding_plans SET archived=1').run();
    expect((await request(2, 'prepare')).status).toBe(404);
  });
});

it('binds recovery headers to the current authenticated owner and refuses cross-account requests before writes', async () => {
  mocks.user = { userId: 'alice', email: 'alice@example.test' };
  const first = await GET(new Request('http://localhost/api/funding'));
  const scope = first.headers.get('x-bundle-funding-owner-scope')!;
  expect(scope).toMatch(/^[0-9a-f]{64}$/);
  expect(first.headers.get('cache-control')).toBe('no-store');
  const saved = await post({}, { 'x-bundle-funding-owner-scope': scope });
  expect(saved.status).toBe(200);
  expect(saved.headers.get('x-bundle-funding-owner-scope')).toBe(scope);
  mocks.user = { userId: 'bob', email: 'bob@example.test' };
  const refused = await post(
    { id: 'foreign-scope' },
    { 'x-bundle-funding-owner-scope': scope },
  );
  expect(refused.status).toBe(403);
  const bobScope = refused.headers.get('x-bundle-funding-owner-scope');
  expect(await refused.json()).toMatchObject({
    code: 'FUNDING_SCOPE_REJECTED_BEFORE_WRITE',
    rejectedScope: scope,
  });
  expect(bobScope).toMatch(/^[0-9a-f]{64}$/);
  expect(bobScope).not.toBe(scope);
  const wrongRead = await GET(
    new Request('http://localhost/api/funding?id=plan-a', {
      headers: { 'x-bundle-funding-owner-scope': scope },
    }),
  );
  expect(wrongRead.status).toBe(403);
  const bob = await GET(new Request('http://localhost/api/funding'));
  expect(await bob.json()).toMatchObject({ plans: [] });
  mocks.user = { userId: 'alice', email: 'alice@example.test' };
  expect(
    (await read(await GET(new Request('http://localhost/api/funding')))).plans,
  ).toHaveLength(1);
});
it.each(['', 'invalid', 'A'.repeat(64)])(
  'refuses malformed supplied owner scope %j without storing a draft',
  async (scope) => {
    mocks.user = { userId: 'alice', email: 'alice@example.test' };
    expect(
      (await post({}, { 'x-bundle-funding-owner-scope': scope })).status,
    ).toBe(403);
    expect(
      (await read(await GET(new Request('http://localhost/api/funding'))))
        .plans,
    ).toHaveLength(0);
  },
);
it('emits no owner namespace to an unauthenticated caller', async () => {
  mocks.user = null;
  for (const response of [
    await GET(new Request('http://localhost/api/funding')),
    await post(),
  ]) {
    expect(response.status).toBe(401);
    expect(response.headers.has('x-bundle-funding-owner-scope')).toBe(false);
  }
});
