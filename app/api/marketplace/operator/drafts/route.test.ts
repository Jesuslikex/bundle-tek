import {
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  expect,
  it,
  vi,
} from 'vitest';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { marketplaceOwnedFixture } from '@/test/marketplace-owned-fixture';
import { readMarketplaceOwnedInventory } from '@/lib/marketplace-owned-inventory-server';
import { reviewOperatorListing } from '@/lib/marketplace-operator-review';
import {
  operatorDraftRequest,
  admitOperatorDraft,
} from '@/lib/marketplace-operator-draft-view';
import {
  saveOperatorDraft,
  readOperatorDraft,
} from '@/lib/marketplace-operator-draft-storage';
const mocks = vi.hoisted(() => ({
  user: { userId: 'operator' } as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { GET, POST } from './route';
let mf: Miniflare, db: D1Database, queries: string[];
const migrations = readFileSync(
  'drizzle/0118_marketplace_operator_drafts.sql',
  'utf8',
)
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter(Boolean);
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'operator-draft-api',
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
          env: { DB: { type: 'd1', id: 'operator-draft-api' } },
        },
      },
    ],
  });
  db = (await mf.getD1Database(
    'DB',
    'operator-draft-api',
  )) as unknown as D1Database;
  for (const sql of [
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,label TEXT,revision INTEGER,updated_at TEXT,archived INTEGER)',
    'CREATE TABLE wallet_ownership_proofs(owner_id TEXT,chain TEXT,address TEXT,verified_at TEXT)',
    'CREATE TABLE warmup_history_runs(owner_id TEXT,id TEXT,revision INTEGER,created_at TEXT,updated_at TEXT,document TEXT)',
    'CREATE TABLE warmup_buy_receipts(owner_id TEXT,wallet_address TEXT,signature TEXT)',
    'CREATE TABLE warmup_sell_receipts(owner_id TEXT,signature TEXT,document TEXT)',
  ])
    await db.prepare(sql).run();
});
afterAll(async () => mf?.dispose());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
beforeEach(async () => {
  await db.prepare('DROP TABLE IF EXISTS marketplace_operator_drafts').run();
  for (const table of [
    'workspace_wallets',
    'wallet_ownership_proofs',
    'warmup_history_runs',
    'warmup_buy_receipts',
    'warmup_sell_receipts',
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
  for (const sql of migrations) await db.prepare(sql).run();
  const f = marketplaceOwnedFixture();
  for (const item of f.sources.wallets) {
    const w = item as {
      address: string;
      label: string;
      revision: number;
      updatedAt: string;
    };
    await db
      .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?,?,?)')
      .bind(
        'operator',
        'Solana',
        w.address,
        w.label,
        w.revision,
        w.updatedAt,
        0,
      )
      .run();
  }
  for (const item of f.sources.proofs) {
    const p = item as { address: string; verifiedAt: string };
    await db
      .prepare('INSERT INTO wallet_ownership_proofs VALUES(?,?,?,?)')
      .bind('operator', 'Solana', p.address, p.verifiedAt)
      .run();
  }
  for (const item of f.sources.runs) {
    const r = item as {
      id: string;
      revision: number;
      createdAt: string;
      updatedAt: string;
      document: string;
    };
    await db
      .prepare('INSERT INTO warmup_history_runs VALUES(?,?,?,?,?,?)')
      .bind('operator', r.id, r.revision, r.createdAt, r.updatedAt, r.document)
      .run();
  }
  queries = [];
  mocks.user = { userId: 'operator' };
  mocks.db = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          queries.push(sql);
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  vi.stubEnv('MARKETPLACE_OPERATOR_USER_IDS', '["operator"]');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No provider requests permitted');
    }),
  );
});
const signal = () => new AbortController().signal;
async function selection() {
  const inventory = await readMarketplaceOwnedInventory(
    db,
    'operator',
    signal(),
  );
  const review = await reviewOperatorListing(inventory, {
    address: inventory.wallets[0].address,
    walletRevision: 2,
    priceLamports: '50000000',
  });
  return operatorDraftRequest(crypto.randomUUID(), review, true);
}
const get = (id: string) =>
  GET(new Request('http://localhost/api/marketplace/operator/drafts?id=' + id));
function post(
  body: unknown,
  headers: Record<string, string> = {
    origin: 'http://localhost',
    'content-type': 'application/json',
  },
  abort?: AbortSignal,
) {
  return POST(
    new Request('http://localhost/api/marketplace/operator/drafts', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: abort,
    }),
  );
}
const count = async () =>
  Number(
    (await db
      .prepare('SELECT count(*) AS n FROM marketplace_operator_drafts')
      .first<{ n: number }>())!.n,
  );
it('checks verified session and server operator policy before SQL for both methods', async () => {
  for (const user of [null, { userId: 'buyer' }]) {
    mocks.user = user;
    const expected = user ? 403 : 401;
    expect((await get(crypto.randomUUID())).status).toBe(expected);
    expect((await post({ role: 'operator' })).status).toBe(expected);
  }
  mocks.user = { userId: 'operator' };
  vi.stubEnv('MARKETPLACE_OPERATOR_USER_IDS', '*');
  expect((await get(crypto.randomUUID())).status).toBe(403);
  expect(queries).toEqual([]);
});
it('saves, replays and recovers one immutable owner-scoped draft with every authority false', async () => {
  const input = await selection(),
    response = await post(input);
  expect(response.status).toBe(200);
  const { draft } = (await response.json()) as { draft: unknown };
  expect(await admitOperatorDraft(draft, input)).toEqual(draft);
  expect(draft).toMatchObject({
    publicationAllowed: false,
    paymentAllowed: false,
    deliveryAllowed: false,
    signingAllowed: false,
  });
  expect(await (await get(input.id)).json()).toEqual({ draft });
  expect((await post(input)).status).toBe(200);
  expect(await count()).toBe(1);
  expect(await readOperatorDraft(db, 'buyer', input.id, signal())).toBeNull();
  await expect(
    db
      .prepare('UPDATE marketplace_operator_drafts SET document=document')
      .run(),
  ).rejects.toThrow('immutable');
  await expect(
    db.prepare('DELETE FROM marketplace_operator_drafts').run(),
  ).rejects.toThrow('immutable');
  expect(fetch).not.toHaveBeenCalled();
});
it('retains historical drafts after expiry and archival without granting publication', async () => {
  const input = await selection(),
    record = await saveOperatorDraft(db, 'operator', input, signal());
  await db
    .prepare('UPDATE workspace_wallets SET archived=1,revision=revision+1')
    .run();
  expect(
    await saveOperatorDraft(
      db,
      'operator',
      input,
      signal(),
      () => Date.now() + 86400000,
    ),
  ).toEqual(record);
  expect(await count()).toBe(1);
});
it('requires same origin, bounded JSON and exact separate acknowledgement', async () => {
  const input = await selection();
  expect(
    (
      await post(input, {
        'content-type': 'application/json',
        origin: 'https://other.test',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await post(input, {
        origin: 'http://localhost',
        'content-type': 'text/plain',
      })
    ).status,
  ).toBe(415);
  expect((await post({ ...input, acknowledgement: undefined })).status).toBe(
    400,
  );
  expect((await post({ ...input, ownerId: 'other' })).status).toBe(400);
  expect((await post('x'.repeat(3000))).status).toBe(413);
  expect((await get(input.id + '&owner=other')).status).toBe(400);
  expect((await get(input.id + '&id=' + input.id)).status).toBe(400);
  expect(await count()).toBe(0);
});
it.each(['price', 'hash', 'proof', 'wallet', 'history', 'receipts'] as const)(
  'refuses changed fresh evidence or request: %s',
  async (kind) => {
    const input = await selection();
    if (kind === 'price') input.selection.priceLamports = '1';
    if (kind === 'hash') input.evidenceSha256 = '0'.repeat(64);
    if (kind === 'proof')
      await db.prepare('DELETE FROM wallet_ownership_proofs').run();
    if (kind === 'wallet')
      await db.prepare("UPDATE workspace_wallets SET label='Changed'").run();
    if (kind === 'history')
      await db.prepare('DELETE FROM warmup_history_runs').run();
    if (kind === 'receipts')
      await db
        .prepare('INSERT INTO warmup_buy_receipts VALUES(?,?,?)')
        .bind('operator', input.selection.address, 'new-receipt')
        .run();
    expect((await post(input)).status).toBe(409);
    expect(await count()).toBe(0);
  },
);
function hooked(hook: () => Promise<void>, lost = false) {
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith('INSERT INTO marketplace_operator_drafts'))
            return statement;
          return {
            bind(...values: unknown[]) {
              const bound = statement.bind(...values);
              return {
                async run() {
                  await hook();
                  const result = await bound.run();
                  if (lost) throw Error('response lost');
                  return result;
                },
              };
            },
          };
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
it('refuses an insertion-time owner or wallet revision change in the database', async () => {
  const input = await selection();
  const raced = hooked(async () => {
    await db.prepare('UPDATE workspace_wallets SET revision=revision+1').run();
  });
  await expect(
    saveOperatorDraft(raced, 'operator', input, signal()),
  ).rejects.toThrow(/changed|retained/);
  expect(await count()).toBe(0);
});
it('recovers a committed insert after response loss with exactly one write attempt', async () => {
  const input = await selection();
  let attempts = 0;
  const saved = await saveOperatorDraft(
    hooked(async () => {
      attempts++;
    }, true),
    'operator',
    input,
    signal(),
  );
  expect(saved.id).toBe(input.id);
  expect(attempts).toBe(1);
  expect(await count()).toBe(1);
});
it('never overwrites an existing identity or stores a duplicate snapshot under another ID', async () => {
  const input = await selection();
  expect((await post(input)).status).toBe(200);
  expect((await post({ ...input, requestSha256: '0'.repeat(64) })).status).toBe(
    409,
  );
  expect((await post({ ...input, id: crypto.randomUUID() })).status).toBe(409);
  expect(await count()).toBe(1);
});
it('refuses expiry, cancellation, missing schema and corrupted stored evidence without leaking parser or SQL text', async () => {
  const input = await selection();
  await expect(
    saveOperatorDraft(
      db,
      'operator',
      input,
      signal(),
      () => Date.now() + 60000,
    ),
  ).rejects.toThrow('expired');
  const controller = new AbortController();
  controller.abort();
  expect((await post(input, undefined, controller.signal)).status).toBe(408);
  expect(await count()).toBe(0);
  expect((await post(input)).status).toBe(200);
  await db.prepare('DROP TRIGGER marketplace_operator_drafts_no_update').run();
  expect((await get(input.id)).status).toBe(503);
  await db
    .prepare("UPDATE marketplace_operator_drafts SET document='{}'")
    .run();
  await db.prepare(migrations[3]).run();
  const response = await get(input.id);
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toMatch(
    /SELECT|Zod|privateKey/,
  );
});
it('database guard rejects enabling publication even without the service validator', async () => {
  const input = await selection(),
    record = await saveOperatorDraft(db, 'operator', input, signal());
  const invalid = {
    ...record,
    id: crypto.randomUUID(),
    publicationAllowed: true,
    reviewSha256: '0'.repeat(64),
  };
  await expect(
    db
      .prepare('INSERT INTO marketplace_operator_drafts VALUES(?,?,?,?,?,?,?)')
      .bind(
        'operator',
        invalid.id,
        input.selection.address,
        2,
        '0'.repeat(64),
        JSON.stringify(invalid),
        invalid.createdAt,
      )
      .run(),
  ).rejects.toThrow();
  expect(await count()).toBe(1);
});
