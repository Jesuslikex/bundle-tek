import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
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
} from '@/lib/marketplace-publication-storage';
import {
  PUBLICATION_ACK,
  type PublicationRecord,
} from '@/lib/marketplace-publication';
import {
  buildCartRequest,
  reviewMarketplaceCart,
} from '@/lib/marketplace-cart';
import {
  makeReservationRequest,
  RESERVATION_CANCEL_ACK,
  reservationRecord,
} from '@/lib/marketplace-reservation';
import { walletWarmupSessionDigest as digest } from '@/lib/wallet-warmup-session-digest';
import {
  reserveMarketplaceCart,
  releaseMarketplaceReservation,
} from '@/lib/marketplace-reservation-storage';
import { admitReservationHistory } from '@/lib/marketplace-reservation-history';
const mocks = vi.hoisted(() => ({
  user: { userId: 'buyer' } as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { GET, POST } from './route';
let client: Client,
  db: D1Database,
  publications: PublicationRecord[],
  queries: string[];
const signal = () => new AbortController().signal;
async function reservationBody(response: Response) {
  return z
    .object({
      reservation: z
        .object({
          record: reservationRecord,
          releasedAt: z.iso.datetime().nullable(),
          state: z.enum(['held', 'released', 'expired']),
        })
        .strict(),
    })
    .strict()
    .parse(await response.json());
}
beforeEach(async () => {
  client = createClient({ url: 'file::memory:', intMode: 'number' });
  db = createTursoDatabase(client);
  for (const sql of [
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,folder_id TEXT,folder_ids TEXT,label TEXT,role TEXT,tags TEXT,revision INTEGER,updated_at TEXT,archived INTEGER)',
    'CREATE TABLE wallet_ownership_proofs(owner_id TEXT,chain TEXT,address TEXT,verified_at TEXT)',
    'CREATE TABLE warmup_history_runs(owner_id TEXT,id TEXT,revision INTEGER,created_at TEXT,updated_at TEXT,document TEXT)',
    'CREATE TABLE warmup_buy_receipts(owner_id TEXT,wallet_address TEXT,signature TEXT)',
    'CREATE TABLE warmup_sell_receipts(owner_id TEXT,signature TEXT,document TEXT)',
  ])
    await db.prepare(sql).run();
  for (const file of [
    '0118_marketplace_operator_drafts',
    '0160_marketplace_operator_draft_review_window',
    '0161_marketplace_reservation_payments',
    '0119_marketplace_publications',
    '0120_marketplace_reservations',
    '0121_marketplace_reservation_history',
    '0159_marketplace_reservation_settlement',
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
      .prepare(
        "INSERT INTO workspace_wallets(owner_id,chain,address,label,revision,updated_at,archived) VALUES(?,?,?,?,?,?,?)",
      )
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
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No provider calls');
    }),
  );
  await db
    .prepare(
      'CREATE TABLE market_read_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER NOT NULL)',
    )
    .run();
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
});
afterEach(() => {
  client?.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function input(ids = publications.map((p) => p.id)) {
  const catalog = await readBundleCatalog(db, signal());
  return {
    action: 'reserve',
    ...makeReservationRequest(
      crypto.randomUUID(),
      await reviewMarketplaceCart(
        await buildCartRequest(catalog, ids),
        catalog,
      ),
      true,
    ),
  };
}
const post = (
  value: unknown,
  headers: Record<string, string> = {
    origin: 'http://localhost',
    'content-type': 'application/json',
  },
  abort?: AbortSignal,
) =>
  POST(
    new Request('http://localhost/api/marketplace/reservations', {
      method: 'POST',
      headers,
      body: typeof value === 'string' ? value : JSON.stringify(value),
      signal: abort,
    }),
  );
const get = (query: string) =>
  GET(new Request('http://localhost/api/marketplace/reservations?' + query));
it('authenticates both methods before database access and refuses caller-supplied identities', async () => {
  mocks.user = null;
  expect((await get('id=' + crypto.randomUUID())).status).toBe(401);
  expect((await post({})).status).toBe(401);
  expect(queries).toEqual([]);
  mocks.user = { userId: 'buyer' };
  const selected = await input();
  queries = [];
  expect((await post({ ...selected, buyerId: 'operator' })).status).toBe(400);
  expect(queries).toEqual([]);
});
it('reserves once, hides held wallets from every catalog, recovers and releases without payment authority', async () => {
  const selected = await input(),
    response = await post(selected),
    body = await reservationBody(response);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(body.reservation).toMatchObject({
    state: 'held',
    record: {
      paymentEnabled: false,
      signingAllowed: false,
      purchaseEnabled: false,
      deliveryEnabled: false,
    },
  });
  expect((await readBundleCatalog(db, signal())).listings).toHaveLength(0);
  expect((await get('id=' + selected.id)).status).toBe(200);
  expect((await post(selected)).status).toBe(200);
  const released = await post({
    action: 'release',
    id: selected.id,
    contextSha256: body.reservation.record.contextSha256,
    acknowledgement: RESERVATION_CANCEL_ACK,
  });
  expect(released.status).toBe(200);
  expect((await reservationBody(released)).reservation.state).toBe('released');
  expect((await readBundleCatalog(db, signal())).listings).toHaveLength(2);
  expect(
    (
      await db
        .prepare('SELECT count(*) AS n FROM marketplace_reservations')
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
});
it('isolates buyer recovery and release and requires one exact GET selector', async () => {
  const selected = await input(),
    saved = await reservationBody(await post(selected));
  mocks.user = { userId: 'other' };
  expect((await get('id=' + selected.id)).status).toBe(404);
  expect(
    (
      await post({
        action: 'release',
        id: selected.id,
        contextSha256: saved.reservation.record.contextSha256,
        acknowledgement: RESERVATION_CANCEL_ACK,
      })
    ).status,
  ).toBe(404);
  for (const query of [
    '',
    'id=nope',
    'id=' + selected.id + '&id=' + selected.id,
    'id=' + selected.id + '&buyerId=buyer',
  ])
    expect((await get(query)).status).toBe(400);
});
it('rejects wrong origin, encoding, oversized streaming body, incomplete consent and cancellation before SQL', async () => {
  const selected = await input();
  queries = [];
  expect(
    (
      await post(selected, {
        origin: 'https://other',
        'content-type': 'application/json',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await post(selected, {
        origin: 'http://localhost',
        'content-type': 'text/plain',
      })
    ).status,
  ).toBe(415);
  expect((await post({ ...selected, acknowledgement: '' })).status).toBe(400);
  expect((await post(' '.repeat(524289))).status).toBe(413);
  const c = new AbortController();
  c.abort();
  expect((await post(selected, undefined, c.signal)).status).toBe(408);
  expect(queries).toEqual([]);
});
it('paces only new holds, preserves unrelated reads, and leaves recovery and release available', async () => {
  const selected = await input([publications[0].id]),
    other = await input([publications[1].id]);
  await db
    .prepare('INSERT INTO market_read_gates VALUES(?,?)')
    .bind('buyer', Date.now() + 60000)
    .run();
  const saved = await reservationBody(await post(selected));
  expect(saved.reservation.state).toBe('held');
  expect((await post(other)).status).toBe(409);
  expect((await get('id=' + selected.id)).status).toBe(200);
  expect(
    (
      await post({
        action: 'release',
        id: selected.id,
        contextSha256: saved.reservation.record.contextSha256,
        acknowledgement: RESERVATION_CANCEL_ACK,
      })
    ).status,
  ).toBe(200);
  const paced = await post(other);
  expect(paced.status).toBe(429);
  expect(paced.headers.get('retry-after')).toBe('15');
  const key = 'marketplace-reservation:' + (await digest('buyer'));
  await db
    .prepare('UPDATE market_read_gates SET next_allowed_at=0 WHERE owner_id=?')
    .bind(key)
    .run();
  expect((await post(other)).status).toBe(200);
  expect(
    (await db
      .prepare('SELECT next_allowed_at FROM market_read_gates WHERE owner_id=?')
      .bind('buyer')
      .first<{ next_allowed_at: number }>())!.next_allowed_at,
  ).toBeGreaterThan(Date.now());
});
it('refuses stale cart content and missing reservation guards with safe errors', async () => {
  const selected = await input();
  expect(
    (
      await post({
        ...selected,
        review: { ...selected.review, askingPriceLamports: '1' },
      })
    ).status,
  ).toBe(409);
  await db.prepare('DROP TRIGGER marketplace_reservations_insert').run();
  const response = await get('id=' + selected.id);
  expect(response.status).toBe(503);
  const text = await response.text();
  expect(text).not.toMatch(/sqlite|SELECT |trigger|stack/i);
  await expect(readBundleCatalog(db, signal())).rejects.toThrow(
    /not installed/,
  );
});
it('finds only owned holds with stable indexed pages and no writes or financial authority', async () => {
  const { action: _action, ...template } = await input();
  async function seed(owner: string) {
    const result = await reserveMarketplaceCart(
      db,
      owner,
      { ...template, id: crypto.randomUUID() },
      signal(),
    );
    await releaseMarketplaceReservation(
      db,
      owner,
      {
        id: result.record.id,
        contextSha256: result.record.contextSha256,
        acknowledgement: RESERVATION_CANCEL_ACK,
      },
      signal(),
    );
    return result.record.id;
  }
  const other = await seed('other'),
    ids = [];
  for (let i = 0; i < 25; i++) ids.push(await seed('buyer'));
  queries = [];
  const firstResponse = await get('history=1'),
    first = admitReservationHistory(await firstResponse.json());
  expect(firstResponse.status).toBe(200);
  expect(firstResponse.headers.get('cache-control')).toBe('no-store');
  expect(first.entries).toHaveLength(20);
  expect(first.nextCursor).not.toBeNull();
  const query = new URLSearchParams({
    history: '1',
    beforeCreatedAt: first.nextCursor!.createdAt,
    beforeId: first.nextCursor!.id,
  });
  const second = admitReservationHistory(
    await (await get(query.toString())).json(),
    first.nextCursor,
  );
  expect(second.entries).toHaveLength(5);
  expect(second.nextCursor).toBeNull();
  expect(
    new Set([...first.entries, ...second.entries].map((e) => e.id)),
  ).toEqual(new Set(ids));
  expect(first.entries.some((e) => e.id === other)).toBe(false);
  expect(first).toMatchObject({
    reserveAllowed: false,
    releaseAllowed: false,
    purchaseEnabled: false,
    paymentEnabled: false,
    deliveryEnabled: false,
    signingAllowed: false,
  });
  expect(Object.hasOwn(first.entries[0], 'record')).toBe(false);
  expect(queries.every((q) => /^SELECT\b/i.test(q.trim()))).toBe(true);
  expect(
    queries.some((q) =>
      q.includes('INDEXED BY marketplace_reservations_buyer_history'),
    ),
  ).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
it('validates history selectors and auth before SQL, including missing cursor halves and duplicates', async () => {
  queries = [];
  mocks.user = null;
  expect((await get('history=1')).status).toBe(401);
  mocks.user = { userId: 'buyer' };
  for (const query of [
    'history=1&id=' + crypto.randomUUID(),
    'history=1&history=1',
    'history=1&buyerId=other',
    'history=1&beforeId=' + crypto.randomUUID(),
    'history=1&beforeCreatedAt=bad&beforeId=' + crypto.randomUUID(),
  ])
    expect((await get(query)).status).toBe(400);
  expect(queries).toEqual([]);
  const c = new AbortController();
  c.abort();
  expect(
    (
      await GET(
        new Request('http://localhost/api/marketplace/reservations?history=1', {
          signal: c.signal,
        }),
      )
    ).status,
  ).toBe(408);
  expect(queries).toEqual([]);
});
it('returns empty history and fails closed on missing index or corrupt owned receipts', async () => {
  expect(
    admitReservationHistory(await (await get('history=1')).json()).entries,
  ).toEqual([]);
  const selected = await input(),
    saved = await reservationBody(await post(selected));
  await db.prepare('DROP INDEX marketplace_reservations_buyer_history').run();
  expect((await get('history=1')).status).toBe(503);
  expect((await get('id=' + selected.id)).status).toBe(200);
  await db
    .prepare(
      readFileSync('drizzle/0121_marketplace_reservation_history.sql', 'utf8'),
    )
    .run();
  await db.prepare('DROP TRIGGER marketplace_reservations_no_update').run();
  await db
    .prepare(
      "UPDATE marketplace_reservations SET document=json_set(document,'$.review.askingPriceLamports','1') WHERE id=?",
    )
    .bind(saved.reservation.record.id)
    .run();
  const result = await get('history=1');
  expect(result.status).toBe(503);
  expect(await result.text()).not.toMatch(
    /sqlite|SELECT |stack|askingPriceLamports/,
  );
});

it('settles a held reservation into the buyer workspace once, idempotently', async () => {
  const selected = await input();
  const held = await reservationBody(await post(selected));
  const addresses = held.reservation.record.review.items.map(
    (e) => e.listing.address,
  );
  const asking = held.reservation.record.review.askingPriceLamports;
  const paid = await post({
    action: 'pay',
    id: selected.id,
    signature: '5'.repeat(88),
    lamports: asking,
    sellerWallet: 'So11111111111111111111111111111111111111112',
  });
  expect(paid.status).toBe(200);
  const first = await post({ action: 'settle', id: selected.id });
  expect(first.status).toBe(200);
  const body = (await first.json()) as {
    settled: { settledAt: string; walletCount: number };
  };
  expect(body.settled.walletCount).toBe(addresses.length);
  const rows = await db
    .prepare(
      "SELECT address,label,role,tags FROM workspace_wallets WHERE owner_id='buyer' ORDER BY address",
    )
    .all<{ address: string; label: string; role: string; tags: string }>();
  expect(rows.results.map((r) => r.address).sort()).toEqual(
    [...addresses].sort(),
  );
  expect(rows.results.map((r) => r.label).sort()).toEqual(
    addresses.map((_, i) => `Purchased ${i + 1}`).sort(),
  );
  expect(rows.results.every((r) => r.role === 'Recipient')).toBe(true);
  expect(rows.results.every((r) => r.tags === '["purchased"]')).toBe(true);
  const again = await post({ action: 'settle', id: selected.id });
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual(body);
  const count = await db
    .prepare(
      "SELECT count(*) AS n FROM workspace_wallets WHERE owner_id='buyer'",
    )
    .first<{ n: number }>();
  expect(count?.n).toBe(addresses.length);
});
it('refuses to settle a released or unknown reservation', async () => {
  const selected = await input();
  const held = await reservationBody(await post(selected));
  await post({
    action: 'release',
    id: selected.id,
    contextSha256: held.reservation.record.contextSha256,
    acknowledgement: RESERVATION_CANCEL_ACK,
  });
  const released = await post({ action: 'settle', id: selected.id });
  expect(released.status).toBe(409);
  expect(await released.text()).toMatch(/released/);
  const missing = await post({ action: 'settle', id: crypto.randomUUID() });
  expect(missing.status).toBe(404);
});

it('records the exact reviewed payment once and refuses an underpayment', async () => {
  const selected = await input();
  const held = await reservationBody(await post(selected));
  const asking = held.reservation.record.review.askingPriceLamports;
  const pay = (lamports: string) =>
    post({
      action: 'pay',
      id: selected.id,
      signature: '5'.repeat(88),
      lamports,
      sellerWallet: 'So11111111111111111111111111111111111111112',
    });

  const short = await pay(String(BigInt(asking) - 1n));
  expect(short.status).toBe(409);
  expect(await short.text()).toMatch(/below the reviewed total/);

  const first = await pay(asking);
  expect(first.status).toBe(200);
  const body = (await first.json()) as {
    payment: { signature: string; lamports: string; paidAt: string };
  };
  expect(body.payment.lamports).toBe(asking);

  // A replay returns the stored record rather than writing a second one.
  const again = await pay(asking);
  expect(again.status).toBe(200);
  expect(((await again.json()) as typeof body).payment.paidAt).toBe(
    body.payment.paidAt,
  );
  const rows = await db
    .prepare('SELECT count(*) AS n FROM marketplace_reservation_payments')
    .first<{ n: number }>();
  expect(rows?.n).toBe(1);
});

it('refuses a payment on a released reservation and an unknown one', async () => {
  const selected = await input();
  const held = await reservationBody(await post(selected));
  await post({
    action: 'release',
    id: selected.id,
    contextSha256: held.reservation.record.contextSha256,
    acknowledgement: RESERVATION_CANCEL_ACK,
  });
  const released = await post({
    action: 'pay',
    id: selected.id,
    signature: '5'.repeat(88),
    lamports: held.reservation.record.review.askingPriceLamports,
    sellerWallet: 'So11111111111111111111111111111111111111112',
  });
  expect(released.status).toBe(409);
  expect(await released.text()).toMatch(/released/);

  const missing = await post({
    action: 'pay',
    id: crypto.randomUUID(),
    signature: '5'.repeat(88),
    lamports: '1',
    sellerWallet: 'So11111111111111111111111111111111111111112',
  });
  expect(missing.status).toBe(404);
});