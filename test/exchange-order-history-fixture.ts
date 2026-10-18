import bs58 from 'bs58';
import { exchangeFundingReviewFixture } from './exchange-funding-review-fixture';
import { exchangeOrderAuthority } from '../lib/exchange-order-review';
export function exchangeOrderHistoryFixture() {
  const base = exchangeFundingReviewFixture(
    Date.parse('2026-10-18T12:00:00.000Z'),
  );
  const id = '00000000-0000-4000-8000-000000000002',
    sha256 = 'a'.repeat(64),
    createdAt = base.review.quotedAt;
  const item = {
    id,
    sha256,
    createdAt,
    quote: base.review,
    providerStatus: null,
    attemptRetained: false,
    receiptRetained: false,
    ...exchangeOrderAuthority,
  };
  const page = {
    format: 'exchange-order-history-v1' as const,
    planId: base.plan.id,
    items: [item],
    nextCursor: null,
    ...exchangeOrderAuthority,
  };
  const detail = {
    format: 'exchange-order-history-detail-v1' as const,
    id,
    sha256,
    createdAt,
    quote: base.review,
    refundAddress: bs58.encode(new Uint8Array(32).fill(8)),
    state: 'review' as const,
    approved: false,
    approvalExpiresAt: null,
    providerStatus: null,
    providerReferenceRetained: false,
    retryCreationAllowed: false,
    payoutVerified: false,
    refundVerified: false,
    currentSpendabilityVerified: false,
    payout: null,
    ...exchangeOrderAuthority,
  };
  return { ...base, id, page, detail };
}
