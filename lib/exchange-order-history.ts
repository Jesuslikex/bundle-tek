import { z } from 'zod';
import { decodeExchangeFundingReview } from './exchange-funding-review';
import {
  exchangeOrderAuthority,
  exchangeRefundAddress,
} from './exchange-order-review';
import { exchangePayoutSignature } from './exchange-payout-signature';

export const exchangeHistoryPlanId = z.string().regex(/^[a-zA-Z0-9-]{1,64}$/);
const stamp = z
  .string()
  .refine(
    (v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v,
  );
const authority = {
  orderCreationAllowed: z.literal(false),
  depositInstructionsAllowed: z.literal(false),
  fundingAllowed: z.literal(false),
  signingAllowed: z.literal(false),
  executionAllowed: z.literal(false),
};
export const exchangeProviderStatus = z.enum([
  'new',
  'waiting',
  'confirming',
  'exchanging',
  'sending',
  'finished',
  'failed',
  'refunded',
  'verifying',
]);
export const exchangeProviderStatusLabels: Record<
  z.infer<typeof exchangeProviderStatus>,
  string
> = {
  new: 'Awaiting deposit',
  waiting: 'Awaiting deposit',
  confirming: 'Confirming deposit',
  exchanging: 'Exchanging',
  sending: 'Sending payout',
  finished: 'Payout reported; proof must be checked',
  failed: 'Failure reported',
  refunded: 'Refund reported; proof must be checked',
  verifying: 'Verification requested',
};
export const exchangeOrderStates = z.enum([
  'review',
  'approved',
  'provider-order-matched',
  'creation-unresolved',
  'provider-processing',
  'provider-failed',
  'provider-verification-required',
  'payout-unverified',
  'refund-unverified',
  'payout-verified',
]);
export const exchangeOrderStateLabels: Record<
  z.infer<typeof exchangeOrderStates>,
  string
> = {
  review: 'Review saved',
  approved: 'Approval recorded',
  'provider-order-matched': 'Order details matched',
  'creation-unresolved': 'Order outcome needs reconciliation',
  'provider-processing': 'Provider reported processing',
  'provider-failed': 'Provider reported a failure',
  'provider-verification-required': 'Provider requested verification',
  'payout-unverified': 'Provider reported payout; receipt not verified',
  'refund-unverified': 'Provider reported refund; receipt not verified',
  'payout-verified': 'Finalized SOL payout verified',
};
const item = z
  .object({
    id: z.uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: stamp,
    quote: z.unknown().transform(decodeExchangeFundingReview),
    providerStatus: exchangeProviderStatus.nullable(),
    attemptRetained: z.boolean(),
    receiptRetained: z.boolean(),
    ...authority,
  })
  .strict();
const page = z
  .object({
    format: z.literal('exchange-order-history-v1'),
    planId: exchangeHistoryPlanId,
    items: z.array(item).max(10),
    nextCursor: z.uuid().nullable(),
    ...authority,
  })
  .strict();
export type ExchangeOrderHistoryPage = z.infer<typeof page>;
export function decodeExchangeOrderHistory(
  value: unknown,
): ExchangeOrderHistoryPage {
  const v = page.parse(value);
  if (
    v.items.some((i) => i.quote.planId !== v.planId) ||
    new Set(v.items.map((i) => i.id)).size !== v.items.length ||
    (v.nextCursor !== null && v.nextCursor !== v.items.at(-1)?.id)
  )
    throw new Error('Saved order history context differs.');
  return v;
}
const detail = z
  .object({
    format: z.literal('exchange-order-history-detail-v1'),
    id: z.uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: stamp,
    quote: z.unknown().transform(decodeExchangeFundingReview),
    refundAddress: z.string().refine((v) => {
      try {
        return exchangeRefundAddress(v) === v;
      } catch {
        return false;
      }
    }),
    state: exchangeOrderStates,
    approved: z.boolean(),
    approvalExpiresAt: stamp.nullable(),
    providerStatus: exchangeProviderStatus.nullable(),
    providerReferenceRetained: z.boolean(),
    retryCreationAllowed: z.literal(false),
    payoutVerified: z.boolean(),
    refundVerified: z.literal(false),
    currentSpendabilityVerified: z.literal(false),
    payout: z
      .object({
        signature: z.string().refine((v) => {
          try {
            return exchangePayoutSignature(v) === v;
          } catch {
            return false;
          }
        }),
        recipient: z.string(),
        amountRaw: z.string(),
        slot: z.number().int().nonnegative(),
        observedAt: stamp,
      })
      .strict()
      .nullable(),
    ...authority,
  })
  .strict();
export type ExchangeOrderHistoryDetail = z.infer<typeof detail>;
export function decodeExchangeOrderHistoryDetail(
  value: unknown,
): ExchangeOrderHistoryDetail {
  const v = detail.parse(value);
  if (
    v.approved !== (v.approvalExpiresAt !== null) ||
    v.payoutVerified !== (v.payout !== null) ||
    v.payoutVerified !== (v.state === 'payout-verified') ||
    (v.payoutVerified &&
      (v.providerStatus !== 'finished' ||
        !v.providerReferenceRetained ||
        !v.approved)) ||
    (v.payout &&
      (v.payout.recipient !== v.quote.funder ||
        v.payout.amountRaw !== v.quote.expectedPayoutLamports))
  )
    throw new Error('Saved payout history context differs.');
  return v;
}
export const exchangeHistoryAuthority = exchangeOrderAuthority;
