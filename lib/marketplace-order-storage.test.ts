import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
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
import { PUBLICATION_ACK } from '@/lib/marketplace-publication';
import {
  buildCartRequest,
  reviewMarketplaceCart,
} from '@/lib/marketplace-cart';
import {
  makeReservationRequest,
  RESERVATION_CANCEL_ACK,
} from './marketplace-reservation';
import {
  releaseMarketplaceReservation,
  reserveMarketplaceCart,
} from './marketplace-reservation-storage';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import type { VaultSession } from './browser-wallet-vault';
import {
  ORDER_ACK,
  orderDeliveryKeys,
  signOrderPayment,
  type OrderDelivery,
} from './marketplace-order';
import {
  cancelMarketplaceOrder,
  createMarketplaceOrder,
  deliverMarketplaceOrder,
  listMarketplaceOrders,
  pendingMarketplaceDeliveries,
  recoverMarketplaceOrder,
  registerMarketplaceOrder,
  submitMarketplaceOrder,
  type OrderRpc,
} from './marketplace-order-storage';

let client: Client, db: D1Database, listed: string[];
const signal = () => new AbortController().signal;
const buyerSeed = new Uint8Array(32).fill(77),
  buyer = bs58.encode(nacl.sign.keyPair.fromSeed(buyerSeed).publicKey),
  payout = bs58.encode(new Uint8Array(32).fill(88)),
  blockhash = bs58.encode(new Uint8Array(32).fill(5));
const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const session = () =>
  ({
    payload: {
      version: 1,
      wallets: [
        {
          id: crypto.randomUUID(),
          family: 'solana',
          address: buyer,
          seed: hex(buyerSeed),
          createdAt: new Date().toISOString(),
        },
      ],
    },
  }) as unknown as VaultSession;

async function apply(file: string) {
  for (const sql of readFileSync('drizzle/' + file + '.sql', 'utf8')
    .split('--> statement-breakpoint')
    .map((x) => x.trim())
    .filter(Boolean))
    await db.prepare(sql).run();
}
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
    '0147_marketplace_orders',
  ])
    await apply(file);
  const wallets = marketplaceOwnedFixture().sources.wallets as {
    address: string;
    label: string;
    revision: number;
    updatedAt: string;
  }[];
  const now = new Date(Date.now() - 60000).toISOString();
  for (const w of wallets) {
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
      .bind('operator', 'Solana', w.address, now)
      .run();
  }
  await db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?,?,?)')
    .bind('buyer', 'Solana', buyer, 'Payer', 1, now, 0)
    .run();
  await db
    .prepare('INSERT INTO wallet_ownership_proofs VALUES(?,?,?,?)')
    .bind('buyer', 'Solana', buyer, now)
    .run();
  listed = [];
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
        priceLamports: '50000000',
      }),
      draft = await saveOperatorDraft(
        db,
        'operator',
        operatorDraftRequest(crypto.randomUUID(), review, true),
        signal(),
      ),
      preview = await previewPublication(db, 'operator', draft.id, signal());
    await publishListing(
      db,
      'operator',
      {
        id: crypto.randomUUID(),
        draftId: draft.id,
        reviewedAt: preview.preview.reviewedAt,
        contextSha256: preview.preview.contextSha256,
        acknowledgement: PUBLICATION_ACK,
      },
      signal(),
    );
    listed.push(w.address);
  }
  vi.stubEnv('MARKETPLACE_OPERATOR_USER_IDS', '["operator"]');
});
afterEach(() => {
  client?.close();
  vi.unstubAllEnvs();
});

async function hold() {
  const catalog = await readBundleCatalog(db, signal());
  return reserveMarketplaceCart(
    db,
    'buyer',
    makeReservationRequest(
      crypto.randomUUID(),
      await reviewMarketplaceCart(
        await buildCartRequest(
          catalog,
          catalog.listings.map((l) => l.id),
        ),
        catalog,
      ),
      true,
    ),
    signal(),
  );
}
function chain(
  options: { land?: 'paid' | 'failed' | 'missing'; balance?: number } = {},
) {
  const sent: string[] = [];
  let signed = '';
  const rpc: OrderRpc = async (method, params) => {
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getLatestBlockhash')
      return {
        context: { slot: 10 },
        value: { blockhash, lastValidBlockHeight: 100 },
      };
    if (method === 'getBalance')
      return { value: options.balance ?? 1_000_000_000 };
    if (method === 'sendTransaction') {
      signed = params[0] as string;
      sent.push(signed);
      return bs58.encode(
        Uint8Array.from(atob(signed), (c) => c.charCodeAt(0)).slice(1, 65),
      );
    }
    if (method === 'getBlockHeight') return 101;
    if (method === 'getTransaction') {
      if (options.land === 'missing') return null;
      return {
        slot: 11,
        blockTime: 1,
        meta: {
          err:
            options.land === 'failed' ? { InstructionError: [0, 'x'] } : null,
          fee: 5000,
          preBalances: [1_000_000_000, 0, 1],
          postBalances:
            options.land === 'failed'
              ? [999_995_000, 0, 1]
              : [1_000_000_000 - 100_000_000 - 5000, 100_000_000, 1],
        },
        transaction: [signed, 'base64'],
      };
    }
    throw Error('unexpected ' + method);
  };
  return { rpc, sent };
}
async function order(
  reservation: Awaited<ReturnType<typeof hold>>,
  rpc: OrderRpc,
  id = crypto.randomUUID(),
) {
  return createMarketplaceOrder(
    db,
    'buyer',
    {
      id,
      reservationId: reservation.record.id,
      reservationSha256: reservation.record.contextSha256,
      buyerWallet: buyer,
      deliveryPublicKey: orderDeliveryKeys(session(), buyer, id).publicKey,
      acknowledgement: ORDER_ACK,
    },
    payout,
    rpc,
    signal(),
  );
}

it('pays a held reservation once, marks the wallets sold and delivers encrypted keys', async () => {
  const reservation = await hold(),
    c = chain();
  const created = await order(reservation, c.rpc);
  expect(created).toMatchObject({
    state: 'awaiting_payment',
    document: {
      amountLamports: '100000000',
      payoutAddress: payout,
      buyerWallet: buyer,
    },
  });
  // Same ID recovers without a second order.
  expect(
    (await order(reservation, c.rpc, created.document.id)).document,
  ).toEqual(created.document);
  const signed = await signOrderPayment(session(), created.document, () => {});
  await registerMarketplaceOrder(
    db,
    'buyer',
    created.document.id,
    signed.transaction,
  );
  // A paid or pending order keeps its reservation.
  await expect(
    releaseMarketplaceReservation(
      db,
      'buyer',
      {
        id: reservation.record.id,
        contextSha256: reservation.record.contextSha256,
        acknowledgement: RESERVATION_CANCEL_ACK,
      },
      signal(),
    ),
  ).rejects.toThrow();
  expect((await readBundleCatalog(db, signal())).listings).toHaveLength(0);
  const submitted = await submitMarketplaceOrder(
    db,
    'buyer',
    created.document.id,
    c.rpc,
  );
  expect(submitted.state).toBe('submitted');
  // Sending again never resends.
  await submitMarketplaceOrder(db, 'buyer', created.document.id, c.rpc);
  expect(c.sent).toEqual([signed.transaction]);
  const paid = await recoverMarketplaceOrder(
    db,
    'buyer',
    created.document.id,
    c.rpc,
  );
  expect(paid).toMatchObject({
    state: 'paid',
    receipt: { amountLamports: '100000000' },
  });

  const pending = await pendingMarketplaceDeliveries(db, 'operator');
  expect(pending).toEqual([
    expect.objectContaining({
      orderId: created.document.id,
      addresses: expect.arrayContaining(listed),
    }),
  ]);
  await expect(pendingMarketplaceDeliveries(db, 'buyer')).rejects.toThrow(
    /seller access/,
  );
  const box = (address: string): OrderDelivery => ({
    address,
    senderPublicKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))),
    nonce: btoa(String.fromCharCode(...new Uint8Array(24).fill(2))),
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(48).fill(3))),
  });
  expect(
    await deliverMarketplaceOrder(
      db,
      'operator',
      created.document.id,
      listed.map(box),
    ),
  ).toEqual([]);
  await expect(
    deliverMarketplaceOrder(db, 'operator', created.document.id, [
      box(listed[0]),
    ]),
  ).rejects.toThrow(/refused/);
  const [history] = await listMarketplaceOrders(db, 'buyer');
  expect(history.deliveries.map((d) => d.address).sort()).toEqual(
    [...listed].sort(),
  );
});

it('refuses short balances, foreign wallets and a second checkout of the same wallets', async () => {
  const reservation = await hold();
  await expect(
    order(reservation, chain({ balance: 1000 }).rpc),
  ).rejects.toThrow(/asking price/);
  const first = await order(reservation, chain().rpc);
  await expect(order(reservation, chain().rpc)).rejects.toThrow(
    /another checkout|changed/,
  );
  expect(
    (await cancelMarketplaceOrder(db, 'buyer', first.document.id)).state,
  ).toBe('cancelled');
});

it('frees the wallets when a sent payment failed or expired unobserved', async () => {
  for (const land of ['failed', 'missing'] as const) {
    const reservation = await hold(),
      c = chain({ land });
    const created = await order(reservation, c.rpc);
    const signed = await signOrderPayment(
      session(),
      created.document,
      () => {},
    );
    await registerMarketplaceOrder(
      db,
      'buyer',
      created.document.id,
      signed.transaction,
    );
    await submitMarketplaceOrder(db, 'buyer', created.document.id, c.rpc);
    expect(
      (await recoverMarketplaceOrder(db, 'buyer', created.document.id, c.rpc))
        .state,
    ).toBe('failed');
    await releaseMarketplaceReservation(
      db,
      'buyer',
      {
        id: reservation.record.id,
        contextSha256: reservation.record.contextSha256,
        acknowledgement: RESERVATION_CANCEL_ACK,
      },
      signal(),
    );
    expect((await readBundleCatalog(db, signal())).listings).toHaveLength(2);
  }
});
