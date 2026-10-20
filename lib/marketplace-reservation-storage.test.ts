import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { createTursoDatabase } from '@/db/turso';
import { marketplaceOwnedFixture } from '@/test/marketplace-owned-fixture';
import { marketplacePublicationFixture } from '@/test/marketplace-publication-fixture';
import { readMarketplaceOwnedInventory } from '@/lib/marketplace-owned-inventory-server';
import { reviewOperatorListing } from '@/lib/marketplace-operator-review';
import {
  operatorDraftRequest,
  operatorDraftCanonical as canonical,
} from '@/lib/marketplace-operator-draft-view';
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
import {
  buildCartRequest,
  reviewMarketplaceCart,
} from '@/lib/marketplace-cart';
import {
  makeReservationRequest,
  makeReservation,
  admitReservation,
  reservationState,
  RESERVATION_CANCEL_ACK,
  type ReservationRequest,
} from './marketplace-reservation';
import {
  reserveMarketplaceCart,
  readMarketplaceReservation,
  releaseMarketplaceReservation,
} from './marketplace-reservation-storage';
let client: Client, db: D1Database, publications: PublicationRecord[];
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
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No provider calls');
    }),
  );
});
afterEach(() => {
  client?.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function request(ids = publications.map((p) => p.id)) {
  const catalog = await readBundleCatalog(db, signal());
  return makeReservationRequest(
    crypto.randomUUID(),
    await reviewMarketplaceCart(await buildCartRequest(catalog, ids), catalog),
    true,
  );
}
async function rawInsert(
  input: ReservationRequest,
  mutate: (v: Awaited<ReturnType<typeof makeReservation>>) => void = () => {},
) {
  const record = await makeReservation(input);
  mutate(record);
  return db
    .prepare('INSERT INTO marketplace_reservations VALUES(?,?,?,?,?,?,?)')
    .bind(
      record.id,
      'buyer',
      record.contextSha256,
      record.requestSha256,
      canonical(record),
      record.createdAt,
      record.expiresAt,
    )
    .run();
}
it('holds one exact whole cart with no financial authority and recovers it without extending time or writing twice', async () => {
  const input = await request(),
    saved = await reserveMarketplaceCart(db, 'buyer', input, signal());
  expect(saved).toMatchObject({
    state: 'held',
    releasedAt: null,
    record: {
      id: input.id,
      reserved: true,
      purchaseEnabled: false,
      paymentEnabled: false,
      deliveryEnabled: false,
      signingAllowed: false,
      review: { askingPriceLamports: '75000001' },
    },
  });
  expect(await reserveMarketplaceCart(db, 'buyer', input, signal())).toEqual(
    saved,
  );
  expect(
    await readMarketplaceReservation(db, 'other', input.id, signal()),
  ).toBeNull();
  expect(
    (
      await db
        .prepare('SELECT count(*) AS n FROM marketplace_reservations')
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
  expect(
    reservationState(saved.record, null, Date.parse(saved.record.expiresAt)),
  ).toBe('expired');
  expect(
    await admitReservation(
      saved.record,
      input,
      Date.parse(saved.record.expiresAt) + 10000,
    ),
  ).toEqual(saved.record);
});
it('atomically allows only one of two racing buyers and never leaves a partial cart', async () => {
  const first = await request(),
    second = { ...first, id: crypto.randomUUID() };
  const outcomes = await Promise.allSettled([
    reserveMarketplaceCart(db, 'alice', first, signal()),
    reserveMarketplaceCart(db, 'bob', second, signal()),
  ]);
  expect(outcomes.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((x) => x.status === 'rejected')).toHaveLength(1);
  expect(
    (
      await db
        .prepare('SELECT count(*) AS n FROM marketplace_reservations')
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
});
it('refuses an overlapping cart without retaining its otherwise available wallet', async () => {
  const other = await request();
  const input = await request([publications[0].id]);
  await reserveMarketplaceCart(db, 'buyer', input, signal());
  await expect(
    reserveMarketplaceCart(db, 'other', other, signal()),
  ).rejects.toThrow(/already held|changed|unavailable/);
  expect(
    (
      await db
        .prepare('SELECT count(*) AS n FROM marketplace_reservations')
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
});
it('ignores expired historical holds at insertion without deleting or extending them', async () => {
  // A past, content-valid record is seeded only in this disposable database to
  // exercise SQLite expiry without waiting five minutes or changing the system clock.
  const oldAt = Date.now() - 360000,
    fixture = await marketplacePublicationFixture(oldAt),
    selected = await buildCartRequest(
      fixture.catalog,
      fixture.catalog.listings.map((x) => x.id),
      oldAt,
    ),
    old = await makeReservation(
      makeReservationRequest(
        crypto.randomUUID(),
        await reviewMarketplaceCart(selected, fixture.catalog, oldAt),
        true,
      ),
      oldAt,
    );
  await db.prepare('DROP TRIGGER marketplace_reservations_insert').run();
  await db
    .prepare('INSERT INTO marketplace_reservations VALUES(?,?,?,?,?,?,?)')
    .bind(
      old.id,
      'historical-buyer',
      old.contextSha256,
      old.requestSha256,
      canonical(old),
      old.createdAt,
      old.expiresAt,
    )
    .run();
  const insertTrigger = readFileSync(
    'drizzle/0120_marketplace_reservations.sql',
    'utf8',
  )
    .split('--> statement-breakpoint')
    .find((sql) =>
      sql.includes('CREATE TRIGGER marketplace_reservations_insert'),
    )!;
  await db.prepare(insertTrigger).run();
  expect(
    (await readMarketplaceReservation(db, 'historical-buyer', old.id, signal()))
      ?.state,
  ).toBe('expired');
  expect(
    (await reserveMarketplaceCart(db, 'new-buyer', await request(), signal()))
      .state,
  ).toBe('held');
  expect(
    (
      await db
        .prepare('SELECT count(*) AS n FROM marketplace_reservations')
        .first<{ n: number }>()
    )?.n,
  ).toBe(2);
});
it('releases only the exact buyer reservation and allows another buyer without erasing history', async () => {
  const input = await request(),
    saved = await reserveMarketplaceCart(db, 'buyer', input, signal());
  const release = {
    id: input.id,
    contextSha256: saved.record.contextSha256,
    acknowledgement: RESERVATION_CANCEL_ACK,
  };
  await expect(
    releaseMarketplaceReservation(db, 'other', release, signal()),
  ).rejects.toThrow(/not found/);
  await expect(
    releaseMarketplaceReservation(
      db,
      'buyer',
      { ...release, contextSha256: '0'.repeat(64) },
      signal(),
    ),
  ).rejects.toThrow(/exact/);
  const released = await releaseMarketplaceReservation(
    db,
    'buyer',
    release,
    signal(),
  );
  expect(released?.state).toBe('released');
  expect(
    await releaseMarketplaceReservation(db, 'buyer', release, signal()),
  ).toEqual(released);
  expect(
    (await reserveMarketplaceCart(db, 'other', await request(), signal()))
      .state,
  ).toBe('held');
  expect(
    (await readMarketplaceReservation(db, 'buyer', input.id, signal()))?.state,
  ).toBe('released');
});
it.each(['withdrawn', 'revision', 'proof', 'operator'] as const)(
  'refuses changed %s source before reserving any wallet',
  async (kind) => {
    const input = await request();
    if (kind === 'withdrawn')
      await withdrawListing(
        db,
        'operator',
        {
          id: publications[0].id,
          contextSha256: publications[0].preview.contextSha256,
          acknowledgement: WITHDRAWAL_ACK,
        },
        signal(),
      );
    if (kind === 'revision')
      await db
        .prepare('UPDATE workspace_wallets SET revision=revision+1')
        .run();
    if (kind === 'proof')
      await db.prepare('DELETE FROM wallet_ownership_proofs').run();
    if (kind === 'operator') vi.stubEnv('MARKETPLACE_OPERATOR_USER_IDS', '[]');
    await expect(
      reserveMarketplaceCart(db, 'buyer', input, signal()),
    ).rejects.toThrow();
    expect(
      (
        await db
          .prepare('SELECT count(*) AS n FROM marketplace_reservations')
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  },
);
it('requires exact separate consent and refuses ID reuse, altered review contents and expired reviews', async () => {
  const input = await request();
  expect(() => makeReservationRequest(input.id, input.review, false)).toThrow(
    /Separately/,
  );
  await expect(
    reserveMarketplaceCart(
      db,
      'buyer',
      { ...input, acknowledgement: '' },
      signal(),
    ),
  ).rejects.toThrow();
  await expect(
    reserveMarketplaceCart(
      db,
      'buyer',
      { ...input, review: { ...input.review, askingPriceLamports: '1' } },
      signal(),
    ),
  ).rejects.toThrow();
  await expect(
    makeReservation(input, Date.parse(input.review.expiresAt)),
  ).rejects.toThrow();
  await reserveMarketplaceCart(db, 'buyer', input, signal());
  await expect(
    reserveMarketplaceCart(
      db,
      'buyer',
      { ...input, review: { ...input.review, askingPriceLamports: '1' } },
      signal(),
    ),
  ).rejects.toThrow(/another cart/);
});
it('database independently refuses changed source, enabled payment and mutable reservation history', async () => {
  const input = await request();
  await expect(
    rawInsert(input, (record) =>
      Object.assign(record, { paymentEnabled: true }),
    ),
  ).rejects.toThrow();
  await db.prepare('UPDATE workspace_wallets SET archived=1').run();
  await expect(rawInsert(input)).rejects.toThrow(/source changed/);
  await db.prepare('UPDATE workspace_wallets SET archived=0').run();
  await reserveMarketplaceCart(db, 'buyer', input, signal());
  await expect(
    rawInsert({ ...input, id: crypto.randomUUID() }),
  ).rejects.toThrow(/already reserved/);
  await expect(
    db
      .prepare('UPDATE marketplace_reservations SET expires_at=?')
      .bind(new Date(Date.now() + 600000).toISOString())
      .run(),
  ).rejects.toThrow(/immutable/);
  await expect(
    db.prepare('DELETE FROM marketplace_reservations').run(),
  ).rejects.toThrow(/immutable/);
});
it('recovers a committed insert after response loss with exactly one insert attempt', async () => {
  const input = await request();
  let writes = 0;
  const uncertain = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith('INSERT INTO marketplace_reservations'))
            return statement;
          return {
            bind(...args: unknown[]) {
              return {
                async run() {
                  writes++;
                  await statement.bind(...args).run();
                  throw Error('Response lost');
                },
              };
            },
          };
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  expect(
    (await reserveMarketplaceCart(uncertain, 'buyer', input, signal())).state,
  ).toBe('held');
  expect(writes).toBe(1);
});
it('refuses missing schema and cancellation without writes or provider access', async () => {
  const input = await request(),
    c = new AbortController();
  c.abort();
  await expect(
    reserveMarketplaceCart(db, 'buyer', input, c.signal),
  ).rejects.toThrow();
  await db.prepare('DROP TRIGGER marketplace_reservations_insert').run();
  await expect(
    reserveMarketplaceCart(db, 'buyer', input, signal()),
  ).rejects.toThrow(/not installed/);
  expect(fetch).not.toHaveBeenCalled();
});
