import { z } from 'zod';
import { ExchangeFundingError } from './exchange-funding-quote';
import {
  exchangeOrderDigest,
  requireExchangeOrderTerms,
  exchangeOrderAuthority,
} from './exchange-order-review';
import { readOwnedExchangeOrder } from './exchange-order-service';
import {
  decodeExchangeOrderHistory,
  decodeExchangeOrderHistoryDetail,
  exchangeHistoryPlanId,
} from './exchange-order-history';

const fail = (message: string, status = 409): never => {
  throw new ExchangeFundingError(message, status);
};
/** One bounded page query plus owned plan/cursor checks; no provider, RPC or per-item DB fanout. */
export async function listOwnedExchangeOrderHistory(
  db: D1Database,
  owner: string,
  planId: string,
  before?: string,
) {
  if (
    !exchangeHistoryPlanId.safeParse(planId).success ||
    (before !== undefined && !z.uuid().safeParse(before).success)
  )
    return fail('Choose a saved funding draft and valid history cursor.', 400);
  const plan = await db
    .prepare('SELECT id FROM funding_plans WHERE owner_id=? AND id=?')
    .bind(owner, planId)
    .first();
  if (!plan) return fail('Funding history not found.', 404);
  const cursor = before
    ? await db
        .prepare(
          'SELECT id,created_at FROM exchange_funding_order_reviews WHERE owner_id=? AND plan_id=? AND id=?',
        )
        .bind(owner, planId, before)
        .first<{ id: string; created_at: string }>()
    : null;
  if (before && !cursor) return fail('Funding history cursor not found.', 404);
  const result = await db
    .prepare(`SELECT r.id,r.document,r.sha256,r.created_at,
    EXISTS(SELECT 1 FROM exchange_funding_order_attempts a WHERE a.review_id=r.id AND a.owner_id=r.owner_id) AS attempt_retained,
    EXISTS(SELECT 1 FROM exchange_funding_payout_receipts p WHERE p.review_id=r.id AND p.owner_id=r.owner_id) AS receipt_retained,
    (SELECT json_extract(o.document,'$.providerStatus') FROM exchange_funding_order_observations o WHERE o.review_id=r.id AND o.owner_id=r.owner_id ORDER BY o.created_at DESC,o.id DESC LIMIT 1) AS provider_status
    FROM exchange_funding_order_reviews r WHERE r.owner_id=? AND r.plan_id=?
    ${cursor ? 'AND (r.created_at<? OR (r.created_at=? AND r.id<?))' : ''}
    ORDER BY r.created_at DESC,r.id DESC LIMIT 11`)
    .bind(
      owner,
      planId,
      ...(cursor ? [cursor.created_at, cursor.created_at, cursor.id] : []),
    )
    .all<{
      id: string;
      document: string;
      sha256: string;
      created_at: string;
      attempt_retained: number;
      receipt_retained: number;
      provider_status: string | null;
    }>();
  const rows = result.results.slice(0, 10);
  const items = await Promise.all(
    rows.map(async (row) => {
      const terms = requireExchangeOrderTerms(JSON.parse(row.document));
      if (
        terms.id !== row.id ||
        terms.quote.planId !== planId ||
        terms.createdAt !== row.created_at ||
        (await exchangeOrderDigest(owner, terms)) !== row.sha256
      )
        return fail('Saved order history is inconsistent.', 503);
      return {
        id: row.id,
        sha256: row.sha256,
        createdAt: row.created_at,
        quote: terms.quote,
        providerStatus: row.provider_status,
        attemptRetained: Boolean(row.attempt_retained),
        receiptRetained: Boolean(row.receipt_retained),
        ...exchangeOrderAuthority,
      };
    }),
  );
  return decodeExchangeOrderHistory({
    format: 'exchange-order-history-v1',
    planId,
    items,
    nextCursor: result.results.length > 10 ? rows.at(-1)!.id : null,
    ...exchangeOrderAuthority,
  });
}
/** Explicit public projection; private exchange IDs, rate IDs and deposit addresses never leave storage. */
export async function readOwnedExchangeOrderHistory(
  db: D1Database,
  owner: string,
  id: string,
) {
  const order = await readOwnedExchangeOrder(db, owner, id),
    payout = order.payoutReceipt;
  return decodeExchangeOrderHistoryDetail({
    format: 'exchange-order-history-detail-v1',
    id: order.terms.id,
    sha256: order.sha256,
    createdAt: order.terms.createdAt,
    quote: order.terms.quote,
    refundAddress: order.terms.refund.address,
    state: order.state,
    approved: order.approved,
    approvalExpiresAt: order.approvalExpiresAt,
    providerStatus: order.providerStatus,
    providerReferenceRetained: order.providerReferenceRetained,
    retryCreationAllowed: false,
    payoutVerified: order.payoutVerified,
    refundVerified: false,
    currentSpendabilityVerified: false,
    payout: payout
      ? {
          signature: payout.signature,
          recipient: payout.recipient,
          amountRaw: payout.amountRaw,
          slot: payout.slot,
          observedAt: payout.observedAt,
        }
      : null,
    ...exchangeOrderAuthority,
  });
}
