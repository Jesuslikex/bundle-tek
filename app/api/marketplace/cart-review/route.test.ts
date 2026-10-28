import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { createTursoDatabase } from '@/db/turso';
import { marketplaceOwnedFixture } from '@/test/marketplace-owned-fixture';
import { readMarketplaceOwnedInventory } from '@/lib/marketplace-owned-inventory-server';
import { reviewOperatorListing } from '@/lib/marketplace-operator-review';
import { operatorDraftRequest } from '@/lib/marketplace-operator-draft-view';
import { saveOperatorDraft } from '@/lib/marketplace-operator-draft-storage';
import {
  previewPublication,
  publishListing,
  readBundleCatalog,
  withdrawListing,
} from '@/lib/marketplace-publication-storage';
import {
  PUBLICATION_ACK,
  WITHDRAWAL_ACK,
  type PublicationRecord,
} from '@/lib/marketplace-publication';
import { buildCartRequest, admitMarketplaceCart } from '@/lib/marketplace-cart';
const mocks = vi.hoisted(() => ({
  user: { userId: 'buyer' } as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { POST } from './route';
let client: Client,
  db: D1Database,
  publications: PublicationRecord[],
  queries: string[];
const signal = () => new AbortController().signal;
beforeEach(async () => {
  client = createClient({ url: 'file::memory:', intMode: 'number' });
  db = createTursoDatabase(client);
  for (const sql of [
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,label TEXT,revision INTEGER,updated_at TEXT,archived INTEGER)',
    'CREATE TABLE wallet_ownership_proofs(owner_id TEXT,chain TEXT,address TEXT,verified_at TEXT)',
    'CREATE TABLE warmup_history_runs(owner_id TEXT,id TEXT,revision INTEGER,created_at TEXT,updated_at TEXT,document TEXT)',
    'CREATE TABLE warmup_buy_receipts(owner_id TEXT,wallet_address TEXT,signature TEXT)',
    'CREATE TABLE warmup_sell_receipts(owner_id TEXT,signature TEXT,document TEXT)',
  ])
    await db.prepare(sql).run();
  for (const file of [
    '0118_marketplace_operator_drafts',
    '0160_marketplace_operator_draft_review_window',
    '0119_marketplace_publications',
    '0120_marketplace_reservations',
  ])
    for (const sql of readFileSync('drizzle/' + file + '.sql', 'utf8')
      .split('--> statement-breakpoint')
      .map((x) => x.trim())
      .filter(Boolean))
      await db.prepare(sql).run();
  const sources = marketplaceOwnedFixture();
  for (const value of sources.sources.wallets) {
    const w = value as {
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
    await db
      .prepare('INSERT INTO wallet_ownership_proofs VALUES(?,?,?,?)')
      .bind(
        'operator',
        'Solana',
        w.address,
        new Date(Date.now() - 60000).toISOString(),
      )
      .run();
  }
  publications = [];
  for (let i = 0; i < 2; i++) {
    const inventory = await readMarketplaceOwnedInventory(
        db,
        'operator',
        signal(),
      ),
      w = inventory.wallets[i],
      review = await reviewOperatorListing(inventory, {
        address: w.address,
        walletRevision: w.revision,
        priceLamports: i === 0 ? '50000000' : '25000001',
      }),
      draft = await saveOperatorDraft(
        db,
        'operator',
        operatorDraftRequest(crypto.randomUUID(), review, true),
        signal(),
      ),
      publicationReview = await previewPublication(
        db,
        'operator',
        draft.id,
        signal(),
      );
    publications.push(
      await publishListing(
        db,
        'operator',
        {
          id: crypto.randomUUID(),
          draftId: draft.id,
          reviewedAt: publicationReview.preview.reviewedAt,
          contextSha256: publicationReview.preview.contextSha256,
          acknowledgement: PUBLICATION_ACK,
        },
        signal(),
      ),
    );
  }
  vi.stubEnv('MARKETPLACE_OPERATOR_USER_IDS', '["operator"]');
  mocks.user = { userId: 'buyer' };
  queries = [];
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
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No provider calls allowed');
    }),
  );
});
afterEach(() => {
  client?.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const post = (
  body: unknown,
  headers: Record<string, string> = {
    origin: 'http://localhost',
    'content-type': 'application/json',
  },
  abort?: AbortSignal,
) =>
  POST(
    new Request('http://localhost/api/marketplace/cart-review', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: abort,
    }),
  );
async function selection() {
  const catalog = await readBundleCatalog(db, signal());
  return {
    catalog,
    request: await buildCartRequest(
      catalog,
      catalog.listings.map((x) => x.id),
    ),
  };
}
it('authenticates the buyer before SQL and accepts no role, owner or authority claims', async () => {
  mocks.user = null;
  expect((await post({})).status).toBe(401);
  expect(queries).toEqual([]);
  mocks.user = { userId: 'buyer' };
  const { request } = await selection();
  for (const extra of [
    { owner_id: 'operator' },
    { role: 'operator' },
    { paymentEnabled: true },
  ])
    expect((await post({ ...request, ...extra })).status).toBe(400);
  expect(queries).toEqual([]);
});
it('rechecks real publication rows and returns an exact non-authorizing cart using SELECTs only', async () => {
  const { catalog, request } = await selection(),
    response = await post(request);
  expect(response.status).toBe(200);
  const { review } = (await response.json()) as { review: unknown };
  const checked = await admitMarketplaceCart(review, catalog, request);
  expect(checked).toMatchObject({
    askingPriceLamports: '75000001',
    count: 2,
    chain: 'Solana',
    networkFeeLamports: null,
    reserved: false,
    purchaseEnabled: false,
    paymentEnabled: false,
    deliveryEnabled: false,
    signingAllowed: false,
  });
  expect(queries.every((sql) => /^SELECT /i.test(sql))).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['withdrawal', 'wallet-archived', 'operator-revoked'] as const)(
  'refuses selected inventory that became unavailable: %s',
  async (kind) => {
    const { request } = await selection();
    if (kind === 'withdrawal') {
      const p = publications[0];
      await withdrawListing(
        db,
        'operator',
        {
          id: p.id,
          contextSha256: p.preview.contextSha256,
          acknowledgement: WITHDRAWAL_ACK,
        },
        signal(),
      );
    }
    if (kind === 'wallet-archived')
      await db.prepare('UPDATE workspace_wallets SET archived=1').run();
    if (kind === 'operator-revoked')
      vi.stubEnv('MARKETPLACE_OPERATOR_USER_IDS', '["other"]');
    const response = await post(request);
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).toContain('unavailable');
  },
);
it('refuses altered listing fingerprints rather than returning a different price or evidence', async () => {
  const { request } = await selection();
  request.items[0].entrySha256 = '0'.repeat(64);
  expect((await post(request)).status).toBe(409);
});
it('requires same origin, JSON, canonical distinct Solana IDs and a 32 KiB maximum', async () => {
  const { request } = await selection();
  expect(
    (
      await post(request, {
        origin: 'https://other.test',
        'content-type': 'application/json',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await post(request, {
        origin: 'http://localhost',
        'content-type': 'text/plain',
      })
    ).status,
  ).toBe(415);
  for (const invalid of [
    { ...request, chain: 'EVM' },
    { ...request, items: [] },
    { ...request, items: [request.items[0], request.items[0]] },
    { ...request, items: [{ ...request.items[0], price: '1' }] },
  ])
    expect((await post(invalid)).status).toBe(400);
  expect((await post('x'.repeat(32769))).status).toBe(413);
  expect(queries).toEqual([]);
});
it('fails closed on missing storage or cancellation without leaking SQL or sending provider reads', async () => {
  const { request } = await selection(),
    controller = new AbortController();
  controller.abort();
  expect((await post(request, undefined, controller.signal)).status).toBe(408);
  expect(queries).toEqual([]);
  await db.prepare('DROP TRIGGER marketplace_publications_no_update').run();
  const response = await post(request);
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toMatch(
    /SELECT|sqlite|Zod|private/i,
  );
  expect(fetch).not.toHaveBeenCalled();
});
