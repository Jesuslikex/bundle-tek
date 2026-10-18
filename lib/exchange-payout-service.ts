import { z } from 'zod';
import { readOwnedExchangeOrder } from './exchange-order-service';
import {
  collectExchangePayoutReceipt,
  ExchangePayoutError,
  type ExchangePayoutRpc,
} from './exchange-payout-receipt';
import { exchangePayoutSignature } from './exchange-payout-signature';
import {
  exchangePayoutReceiptDigest,
  readStoredExchangePayout,
} from './exchange-payout-storage';

const fail = (message: string, status = 409): never => {
  throw new ExchangePayoutError(message, status);
};
/** Owned receipt composition; the payout API supplies authenticated ownership and bounded server-only RPC. No payment or distribution authority. */
export async function verifyOwnedExchangePayout(
  db: D1Database,
  owner: string,
  reviewId: string,
  signal: AbortSignal,
  rpc: ExchangePayoutRpc,
  now = Date.now,
) {
  if (!z.uuid().safeParse(reviewId).success)
    return fail('Choose a retained owned order.', 400);
  const order = await readOwnedExchangeOrder(db, owner, reviewId);
  const existing = await readStoredExchangePayout(db, owner, reviewId);
  if (existing) return existing;
  const attempt = await db
    .prepare(
      'SELECT created_at FROM exchange_funding_order_attempts WHERE owner_id=? AND review_id=?',
    )
    .bind(owner, reviewId)
    .first<{ created_at: string }>();
  if (!attempt || !order.providerReferenceRetained)
    return fail('A retained provider order attempt is required.');
  const observations = await db
    .prepare(
      "SELECT id,document,created_at FROM exchange_funding_order_observations WHERE owner_id=? AND review_id=? AND length(json_extract(document,'$.payoutHash'))>0 ORDER BY created_at DESC,id DESC",
    )
    .bind(owner, reviewId)
    .all<{ id: string; document: string; created_at: string }>();
  const rows = observations.results.map((row) => ({
    ...row,
    observation: JSON.parse(row.document) as {
      payoutHash: string;
      providerStatus: string;
      payoutAddress: string;
      expectedPayoutLamports: string;
    },
  }));
  const row = rows.find((r) => r.observation.providerStatus === 'finished');
  if (!row)
    return fail(
      'The provider must retain a finished payout signature before verification.',
    );
  const signature = exchangePayoutSignature(row.observation.payoutHash);
  if (
    rows.some((r) => r.observation.payoutHash !== signature) ||
    row.observation.payoutAddress !== order.terms.quote.funder ||
    row.observation.expectedPayoutLamports !==
      order.terms.quote.expectedPayoutLamports
  )
    return fail('Retained payout references or amounts conflict.');
  signal.throwIfAborted();
  const receipt = await collectExchangePayoutReceipt(
    {
      reviewId,
      orderSha256: order.sha256,
      signature,
      recipient: order.terms.quote.funder,
      amountRaw: order.terms.quote.expectedPayoutLamports,
      notBefore: attempt.created_at,
    },
    signal,
    rpc,
    now,
  );
  signal.throwIfAborted();
  const sha256 = await exchangePayoutReceiptDigest(
    owner,
    reviewId,
    row.id,
    receipt,
  );
  signal.throwIfAborted();
  try {
    await db
      .prepare(
        'INSERT INTO exchange_funding_payout_receipts(review_id,owner_id,observation_id,signature,recipient,amount_raw,document,sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        reviewId,
        owner,
        row.id,
        signature,
        receipt.recipient,
        receipt.amountRaw,
        JSON.stringify(receipt),
        sha256,
        receipt.observedAt,
      )
      .run();
  } catch {
    const replay = await readStoredExchangePayout(db, owner, reviewId);
    if (
      replay &&
      replay.signature === receipt.signature &&
      replay.packetSha256 === receipt.packetSha256
    )
      return replay;
    return fail(
      'Payout receipt could not be retained. The order hold remains in place.',
    );
  }
  return receipt;
}
