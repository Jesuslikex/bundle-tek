import {
  ExchangePayoutError,
  type ExchangePayoutReceipt,
} from './exchange-payout-receipt';
import { exchangeOrderAuthority } from './exchange-order-review';
const fail = (message: string, status = 409): never => {
  throw new ExchangePayoutError(message, status);
};
export const exchangePayoutReceiptDigest = async (
  owner: string,
  reviewId: string,
  observationId: string,
  receipt: ExchangePayoutReceipt,
) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(
          JSON.stringify({ owner, reviewId, observationId, receipt }),
        ),
      ),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
export async function readStoredExchangePayout(
  db: D1Database,
  owner: string,
  reviewId: string,
) {
  const row = await db
    .prepare(
      'SELECT * FROM exchange_funding_payout_receipts WHERE owner_id=? AND review_id=?',
    )
    .bind(owner, reviewId)
    .first<{
      observation_id: string;
      signature: string;
      recipient: string;
      amount_raw: string;
      document: string;
      sha256: string;
      created_at: string;
    }>();
  if (!row) return null;
  const receipt = JSON.parse(row.document) as ExchangePayoutReceipt;
  if (
    receipt.format !== 'exchange-payout-receipt-v1' ||
    receipt.reviewId !== reviewId ||
    receipt.signature !== row.signature ||
    receipt.recipient !== row.recipient ||
    receipt.amountRaw !== row.amount_raw ||
    receipt.observedAt !== row.created_at ||
    receipt.payoutVerified !== true ||
    receipt.signatureVerified !== true ||
    receipt.currentSpendabilityVerified !== false ||
    Object.entries(exchangeOrderAuthority).some(
      ([k, v]) => receipt[k as keyof ExchangePayoutReceipt] !== v,
    ) ||
    (await exchangePayoutReceiptDigest(
      owner,
      reviewId,
      row.observation_id,
      receipt,
    )) !== row.sha256
  )
    return fail('Saved payout receipt is inconsistent.', 503);
  return receipt;
}
