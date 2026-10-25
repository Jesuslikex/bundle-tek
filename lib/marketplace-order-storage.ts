import { z } from 'zod';
import bs58 from 'bs58';
import { readMarketplaceReservation } from './marketplace-reservation-storage';
import { isMarketplaceOperator } from './marketplace-operator-policy';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { walletAddress } from './wallet-workspace';
import { decode } from './wallet-cleanup';
import { marketplaceOrdersInstalled } from './marketplace-order-availability';
import {
  ORDER_ACK,
  ORDER_PAYMENT_WINDOW_MS,
  deliveryPublicKey,
  inspectOrderPacket,
  orderDelivery,
  orderDocument,
  unsignedOrderPacket,
  type MarketplaceOrder,
  type OrderDelivery,
  type OrderDocument,
  type OrderState,
} from './marketplace-order';

export class MarketplaceOrderError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
const fail = (message: string, status = 409): never => {
  throw new MarketplaceOrderError(message, status);
};
export type OrderRpc = (method: string, params: unknown[]) => Promise<unknown>;
/** System account rent minimum; a payment may not leave the buyer below it. */
const RENT_EXEMPT = 890_880n;
const FEE = 5_000n;

export const createOrderRequest = z
  .object({
    id: z.uuid(),
    reservationId: z.uuid(),
    reservationSha256: z.string().regex(/^[a-f0-9]{64}$/),
    buyerWallet: z.string(),
    deliveryPublicKey,
    acknowledgement: z.literal(ORDER_ACK),
  })
  .strict();

type Row = {
  id: string;
  document: string;
  state: OrderState;
  signed: string | null;
  signature: string | null;
  receipt: string | null;
  updated_at: string;
};

async function installed(db: D1Database) {
  if (!(await marketplaceOrdersInstalled(db)))
    fail('Marketplace checkout storage is not installed.', 503);
}
async function deliveriesFor(db: D1Database, orderId: string) {
  const { results } = await db
    .prepare(
      'SELECT address,sender_public_key,nonce,ciphertext FROM marketplace_deliveries WHERE order_id=? ORDER BY address',
    )
    .bind(orderId)
    .all<{
      address: string;
      sender_public_key: string;
      nonce: string;
      ciphertext: string;
    }>();
  return results.map((d) =>
    orderDelivery.parse({
      address: d.address,
      senderPublicKey: d.sender_public_key,
      nonce: d.nonce,
      ciphertext: d.ciphertext,
    }),
  );
}
async function view(db: D1Database, row: Row): Promise<MarketplaceOrder> {
  const document = orderDocument.parse(JSON.parse(row.document));
  if (document.id !== row.id) fail('Stored order differs.', 503);
  return {
    document,
    state: row.state,
    signature: row.signature,
    receipt: row.receipt ? JSON.parse(row.receipt) : null,
    updatedAt: row.updated_at,
    deliveries: row.state === 'paid' ? await deliveriesFor(db, row.id) : [],
  };
}
async function readRow(db: D1Database, owner: string, id: string) {
  return db
    .prepare(
      'SELECT id,document,state,signed,signature,receipt,updated_at FROM marketplace_orders WHERE buyer_id=? AND id=?',
    )
    .bind(owner, id)
    .first<Row>();
}
async function mustRead(db: D1Database, owner: string, id: string) {
  const row = await readRow(db, owner, id);
  return row ?? fail('Order not found.', 404);
}

export async function listMarketplaceOrders(db: D1Database, owner: string) {
  await installed(db);
  const { results } = await db
    .prepare(
      'SELECT id,document,state,signed,signature,receipt,updated_at FROM marketplace_orders WHERE buyer_id=? ORDER BY created_at DESC,id DESC LIMIT 20',
    )
    .bind(owner)
    .all<Row>();
  return Promise.all(results.map((row) => view(db, row)));
}

/** Creates one unsigned payment for a held reservation. Same ID recovers it. */
export async function createMarketplaceOrder(
  db: D1Database,
  owner: string,
  value: unknown,
  payout: string | undefined,
  rpc: OrderRpc,
  signal: AbortSignal,
) {
  await installed(db);
  const input = createOrderRequest.parse(value);
  const buyerWallet = walletAddress(input.buyerWallet, 'Solana');
  if (!payout) return fail('Marketplace payments are not configured.', 503);
  const payoutAddress = walletAddress(payout, 'Solana');
  const prior = await readRow(db, owner, input.id);
  if (prior) {
    const order = await view(db, prior);
    if (
      order.document.reservationId !== input.reservationId ||
      order.document.buyerWallet !== buyerWallet ||
      order.document.deliveryPublicKey !== input.deliveryPublicKey
    )
      fail('This order ID belongs to another checkout.');
    return order;
  }
  const held = await readMarketplaceReservation(
    db,
    owner,
    input.reservationId,
    signal,
  );
  if (!held || held.state !== 'held')
    return fail('This reservation is no longer held. Reserve again.');
  if (held.record.contextSha256 !== input.reservationSha256)
    fail('Check out the exact saved reservation.');
  if (buyerWallet === payoutAddress)
    fail('Pay from a wallet other than the Bundle payout wallet.');
  const amount = BigInt(held.record.review.askingPriceLamports);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    fail('Payment network differs.', 502);
  const latest = (await rpc('getLatestBlockhash', [
    { commitment: 'finalized' },
  ])) as {
    context?: { slot?: number };
    value?: { blockhash?: string; lastValidBlockHeight?: number };
  };
  const balance = (await rpc('getBalance', [
    buyerWallet,
    { commitment: 'confirmed' },
  ])) as { value?: number };
  signal.throwIfAborted();
  if (
    !latest?.value?.blockhash ||
    !Number.isSafeInteger(latest.value.lastValidBlockHeight) ||
    !Number.isSafeInteger(latest.context?.slot) ||
    !Number.isSafeInteger(balance?.value)
  )
    fail('Payment network read failed.', 502);
  const left = BigInt(balance.value!) - amount - FEE;
  if (left < 0n || (left > 0n && left < RENT_EXEMPT))
    fail(
      'The paying wallet needs the asking price plus 0.000005 SOL for the fee, and must keep 0 or at least 0.00089088 SOL.',
    );
  const now = Date.now();
  const expiresAt = new Date(
    Math.min(Date.parse(held.record.expiresAt), now + ORDER_PAYMENT_WINDOW_MS),
  ).toISOString();
  const base = {
    buyerWallet,
    payoutAddress,
    blockhash: walletAddress(latest.value!.blockhash, 'Solana'),
    amountLamports: amount.toString(),
  };
  const packet = await unsignedOrderPacket(base);
  const document: OrderDocument = orderDocument.parse({
    format: 'bundle-order-v1',
    id: input.id,
    reservationId: input.reservationId,
    reservationSha256: input.reservationSha256,
    ...base,
    addresses: held.record.review.items.map((i) => i.listing.address),
    deliveryPublicKey: input.deliveryPublicKey,
    lastValidBlockHeight: String(latest.value!.lastValidBlockHeight),
    slot: latest.context!.slot,
    transaction: packet.transaction,
    sha256: packet.sha256,
    createdAt: new Date(now).toISOString(),
    expiresAt,
    acknowledgement: ORDER_ACK,
  });
  try {
    await db
      .prepare(
        "INSERT INTO marketplace_orders(id,buyer_id,reservation_id,reservation_sha256,buyer_wallet,payout_address,amount_lamports,addresses,delivery_public_key,document,sha256,state,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'awaiting_payment',?,?,?)",
      )
      .bind(
        document.id,
        owner,
        document.reservationId,
        document.reservationSha256,
        document.buyerWallet,
        document.payoutAddress,
        document.amountLamports,
        JSON.stringify(document.addresses),
        document.deliveryPublicKey,
        JSON.stringify(document),
        document.sha256,
        document.createdAt,
        document.expiresAt,
        document.createdAt,
      )
      .run();
  } catch (error) {
    const recovered = await readRow(db, owner, input.id);
    if (recovered) return view(db, recovered);
    fail(
      error instanceof Error && /already being sold/.test(error.message)
        ? 'A wallet in this reservation is already in another checkout.'
        : 'The reservation, paying wallet or its ownership proof changed. Reserve again.',
    );
  }
  return view(db, await mustRead(db, owner, input.id));
}

/** Saves the browser-signed payment. Nothing is sent. */
export async function registerMarketplaceOrder(
  db: D1Database,
  owner: string,
  id: string,
  transaction: string,
) {
  await installed(db);
  const row = await mustRead(db, owner, id);
  const order = await view(db, row);
  const signature = (await inspectOrderPacket(
    order.document,
    transaction,
    true,
  ))!;
  if (row.signed) {
    if (row.signature !== signature) fail('A different payment is saved.');
    return order;
  }
  const result = await db
    .prepare(
      "UPDATE marketplace_orders SET state='signed',signed=?,signature=?,updated_at=? WHERE buyer_id=? AND id=? AND state='awaiting_payment' AND signed IS NULL",
    )
    .bind(transaction, signature, new Date().toISOString(), owner, id)
    .run();
  if (!result.meta.changes)
    fail('The order expired or changed before its payment was saved.');
  return view(db, await mustRead(db, owner, id));
}

/** Sends the saved signed payment exactly once while the reservation is held. */
export async function submitMarketplaceOrder(
  db: D1Database,
  owner: string,
  id: string,
  rpc: OrderRpc,
) {
  await installed(db);
  const row = await mustRead(db, owner, id);
  if (row.state !== 'signed' || !row.signed)
    return view(db, row).then((order) =>
      row.state === 'submitted' || row.state === 'paid'
        ? order
        : fail('Sign this payment before sending it.'),
    );
  const order = await view(db, row);
  await inspectOrderPacket(order.document, row.signed, true);
  const armed = await db
    .prepare(
      "UPDATE marketplace_orders SET state='submitted',updated_at=? WHERE buyer_id=? AND id=? AND state='signed' AND signature=?",
    )
    .bind(new Date().toISOString(), owner, id, row.signature)
    .run()
    .catch(() => null);
  if (!armed?.meta.changes)
    fail(
      'The reservation or payment window ended before sending. Nothing was sent.',
    );
  try {
    const sent = await rpc('sendTransaction', [
      row.signed,
      {
        encoding: 'base64',
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 0,
        minContextSlot: order.document.slot,
      },
    ]);
    if (sent !== row.signature) throw new Error();
  } catch {
    fail(
      'Payment outcome is unknown. It is never resent; check its status.',
      502,
    );
  }
  return view(db, await mustRead(db, owner, id));
}

type RawTx = {
  slot?: number;
  blockTime?: number | null;
  meta?: {
    err?: unknown;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
  };
  transaction?: [string, string];
};

/** Reads the finalized payment; a lost or expired payment frees the wallets. */
export async function recoverMarketplaceOrder(
  db: D1Database,
  owner: string,
  id: string,
  rpc: OrderRpc,
) {
  await installed(db);
  const row = await mustRead(db, owner, id);
  const order = await view(db, row);
  if (row.state !== 'submitted' || !row.signed || !row.signature) return order;
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    fail('Payment network differs.', 502);
  const raw = (await rpc('getTransaction', [
    row.signature,
    {
      encoding: 'base64',
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    },
  ])) as RawTx | null;
  const at = new Date().toISOString();
  let state: 'paid' | 'failed';
  let receipt: Record<string, unknown>;
  if (!raw) {
    const height = (await rpc('getBlockHeight', [
      { commitment: 'finalized' },
    ])) as number;
    if (
      !Number.isSafeInteger(height) ||
      BigInt(height) <= BigInt(order.document.lastValidBlockHeight)
    )
      fail('Payment has not finalized yet. Check again shortly.');
    state = 'failed';
    receipt = {
      expiredUnobserved: true,
      finalizedHeight: height,
      observedAt: at,
    };
  } else {
    if (
      raw.transaction?.[1] !== 'base64' ||
      raw.transaction[0] !== row.signed ||
      !raw.meta ||
      !Array.isArray(raw.meta.preBalances) ||
      !Array.isArray(raw.meta.postBalances)
    )
      fail('Finalized payment differs from the signed packet.', 502);
    if (raw.meta!.err !== null) {
      state = 'failed';
      receipt = {
        error: JSON.stringify(raw.meta!.err).slice(0, 200),
        observedAt: at,
      };
    } else {
      const amount = BigInt(order.document.amountLamports);
      const fee = BigInt(raw.meta!.fee ?? 0);
      const pre = raw.meta!.preBalances!.map(BigInt),
        post = raw.meta!.postBalances!.map(BigInt);
      if (post[1] - pre[1] !== amount || pre[0] - post[0] !== amount + fee)
        fail('Finalized payment amounts differ from the order.', 502);
      state = 'paid';
      receipt = {
        signature: row.signature,
        slot: raw.slot,
        blockTime: raw.blockTime ?? null,
        amountLamports: amount.toString(),
        feeLamports: fee.toString(),
        payoutAddress: order.document.payoutAddress,
        observedAt: at,
      };
    }
  }
  await db
    .prepare(
      "UPDATE marketplace_orders SET state=?,receipt=?,updated_at=? WHERE buyer_id=? AND id=? AND state='submitted' AND signature=?",
    )
    .bind(state, JSON.stringify(receipt), at, owner, id, row.signature)
    .run();
  return view(db, await mustRead(db, owner, id));
}

export async function cancelMarketplaceOrder(
  db: D1Database,
  owner: string,
  id: string,
) {
  await installed(db);
  const row = await mustRead(db, owner, id);
  if (row.state !== 'awaiting_payment' && row.state !== 'signed')
    return view(db, row);
  await db
    .prepare(
      "UPDATE marketplace_orders SET state='cancelled',updated_at=? WHERE buyer_id=? AND id=? AND state IN ('awaiting_payment','signed')",
    )
    .bind(new Date().toISOString(), owner, id)
    .run();
  return view(db, await mustRead(db, owner, id));
}

export type PendingDelivery = {
  orderId: string;
  deliveryPublicKey: string;
  paidAt: string;
  addresses: string[];
};

/** Paid orders with wallets this operator published and has not delivered yet. */
export async function pendingMarketplaceDeliveries(
  db: D1Database,
  operator: string,
): Promise<PendingDelivery[]> {
  await installed(db);
  if (!isMarketplaceOperator(operator))
    fail('Bundle seller access required.', 403);
  const { results } = await db
    .prepare(
      `SELECT o.id,o.delivery_public_key,o.updated_at,a.value AS address FROM marketplace_orders o,json_each(o.addresses) a
       WHERE o.state='paid'
       AND EXISTS(SELECT 1 FROM marketplace_publications p WHERE p.owner_id=? AND p.wallet_address=a.value)
       AND NOT EXISTS(SELECT 1 FROM marketplace_deliveries d WHERE d.order_id=o.id AND d.address=a.value)
       ORDER BY o.updated_at,o.id LIMIT 200`,
    )
    .bind(operator)
    .all<{
      id: string;
      delivery_public_key: string;
      updated_at: string;
      address: string;
    }>();
  const orders = new Map<string, PendingDelivery>();
  for (const r of results) {
    const entry = orders.get(r.id) ?? {
      orderId: r.id,
      deliveryPublicKey: r.delivery_public_key,
      paidAt: r.updated_at,
      addresses: [],
    };
    entry.addresses.push(r.address);
    orders.set(r.id, entry);
  }
  return [...orders.values()];
}

/** Stores encrypted keys only; the server cannot read them. */
export async function deliverMarketplaceOrder(
  db: D1Database,
  operator: string,
  orderId: string,
  supplied: unknown,
) {
  await installed(db);
  if (!isMarketplaceOperator(operator))
    fail('Bundle seller access required.', 403);
  z.uuid().parse(orderId);
  const deliveries = z.array(orderDelivery).min(1).max(200).parse(supplied);
  if (new Set(deliveries.map((d) => d.address)).size !== deliveries.length)
    fail('Deliver each wallet once.', 400);
  for (const d of deliveries) {
    if (
      decode(d.senderPublicKey).length !== 32 ||
      decode(d.nonce).length !== 24
    )
      fail('Delivery format differs.', 400);
    bs58.decode(d.address);
  }
  const at = new Date().toISOString();
  try {
    await db.batch(
      deliveries.map((d: OrderDelivery) =>
        db
          .prepare(
            'INSERT INTO marketplace_deliveries(order_id,address,operator_id,sender_public_key,nonce,ciphertext,created_at) VALUES(?,?,?,?,?,?,?)',
          )
          .bind(
            orderId,
            d.address,
            operator,
            d.senderPublicKey,
            d.nonce,
            d.ciphertext,
            at,
          ),
      ),
    );
  } catch {
    fail(
      'Delivery was refused: the order is not paid, a wallet is not yours, or it was already delivered.',
    );
  }
  return pendingMarketplaceDeliveries(db, operator);
}
