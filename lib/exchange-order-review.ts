import { z } from 'zod';
import { walletAddress } from './wallet-workspace';
import { exchangePayoutSignature } from './exchange-payout-signature';
import {
  decodeExchangeFundingReview,
  exchangeSolLamports,
  type ExchangeFundingReview,
} from './exchange-funding-review';

export const EXCHANGE_ORDER_APPROVAL_MS = 5000;
const refund = z
  .object({
    address: z.string().min(32).max(44),
    revision: z.number().int().min(1).max(1e9),
  })
  .strict();
export const exchangeOrderReviewInput = z
  .object({ quoteId: z.uuid(), refund })
  .strict();
export const exchangeOrderConsent = z
  .object({
    reviewId: z.uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    exactAmountsAndNetwork: z.literal(true),
    providerCustody: z.literal(true),
    verificationMayBeRequired: z.literal(true),
    refundAddressReviewed: z.literal(true),
  })
  .strict();
export const exchangeOrderIdentity = z
  .object({ reviewId: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export type ExchangeOrderTerms = {
  format: 'exchange-order-review-v1';
  id: string;
  quote: ExchangeFundingReview;
  refund: { address: string; revision: number };
  createdAt: string;
  expiresAt: string;
  orderCreationAllowed: false;
  depositInstructionsAllowed: false;
  fundingAllowed: false;
  signingAllowed: false;
  executionAllowed: false;
};
export const exchangeOrderAuthority = {
  orderCreationAllowed: false,
  depositInstructionsAllowed: false,
  fundingAllowed: false,
  signingAllowed: false,
  executionAllowed: false,
} as const;
export async function exchangeOrderDigest(
  owner: string,
  terms: ExchangeOrderTerms,
) {
  const bytes = new TextEncoder().encode(JSON.stringify({ owner, terms }));
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
export function exchangeRefundAddress(value: string) {
  if (
    walletAddress(value, 'Solana') !== value ||
    value === '11111111111111111111111111111111'
  )
    throw new Error('Choose a canonical refund wallet.');
  return value;
}
export function requireExchangeOrderTerms(value: unknown): ExchangeOrderTerms {
  const v = z
    .object({
      format: z.literal('exchange-order-review-v1'),
      id: z.uuid(),
      quote: z.unknown(),
      refund,
      createdAt: z.string(),
      expiresAt: z.string(),
      orderCreationAllowed: z.literal(false),
      depositInstructionsAllowed: z.literal(false),
      fundingAllowed: z.literal(false),
      signingAllowed: z.literal(false),
      executionAllowed: z.literal(false),
    })
    .strict()
    .parse(value);
  const quote = decodeExchangeFundingReview(v.quote);
  exchangeRefundAddress(quote.funder);
  exchangeRefundAddress(v.refund.address);
  if (
    v.refund.address === quote.funder ||
    !Number.isFinite(Date.parse(v.createdAt)) ||
    new Date(v.createdAt).toISOString() !== v.createdAt ||
    v.expiresAt !== quote.expiresAt ||
    Date.parse(v.createdAt) >= Date.parse(v.expiresAt)
  )
    throw new Error('Exchange order context or expiry differs.');
  return { ...v, quote };
}
const providerAddress = z.string().refine((v) => {
  try {
    return exchangeRefundAddress(v) === v;
  } catch {
    return false;
  }
});
const noTag = z.union([z.null(), z.literal('')]).optional();
const optionalSignature = z
  .union([
    z.null(),
    z.literal(''),
    z.string().refine((v) => {
      try {
        return exchangePayoutSignature(v) === v;
      } catch {
        return false;
      }
    }),
  ])
  .optional();
export const exchangeProviderId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
/** Fixed native SOL contract derived from Smoke; no arbitrary program or transaction accepted. */
export function matchExchangeProviderOrder(
  value: unknown,
  terms: ExchangeOrderTerms,
  expectedId?: string,
) {
  const v = z
    .object({
      id: exchangeProviderId,
      currency: z.literal('sol'),
      network: z.literal('sol'),
      fromAmount: z.string(),
      toAmount: z.string(),
      payoutAddress: providerAddress,
      payinAddress: providerAddress,
      refundAddress: providerAddress,
      payinExtraId: noTag,
      payoutExtraId: noTag,
      refundExtraId: noTag,
    })
    .parse(value);
  if (
    (expectedId && v.id !== expectedId) ||
    exchangeSolLamports(v.fromAmount) !== terms.quote.depositLamports ||
    exchangeSolLamports(v.toAmount) !== terms.quote.expectedPayoutLamports ||
    v.payoutAddress !== terms.quote.funder ||
    v.refundAddress !== terms.refund.address ||
    [v.payoutAddress, v.refundAddress].includes(v.payinAddress)
  )
    throw new Error(
      'Provider order does not match the approved amounts, wallets and network.',
    );
  return {
    providerId: v.id,
    depositAddress: v.payinAddress,
    payoutAddress: v.payoutAddress,
    refundAddress: v.refundAddress,
    depositLamports: terms.quote.depositLamports,
    expectedPayoutLamports: terms.quote.expectedPayoutLamports,
  };
}
export function observeExchangeProviderOrder(
  value: unknown,
  terms: ExchangeOrderTerms,
  providerId: string,
  depositAddress?: string,
) {
  const v = z
    .object({
      id: exchangeProviderId,
      fromCurrency: z.literal('sol'),
      toCurrency: z.literal('sol'),
      fromNetwork: z.literal('sol'),
      toNetwork: z.literal('sol'),
      expectedAmountFrom: z.string(),
      expectedAmountTo: z.string(),
      payoutAddress: providerAddress,
      payinAddress: providerAddress,
      refundAddress: providerAddress,
      status: z.enum([
        'new',
        'waiting',
        'confirming',
        'exchanging',
        'sending',
        'finished',
        'failed',
        'refunded',
        'verifying',
      ]),
      payinHash: optionalSignature,
      payoutHash: optionalSignature,
      refundHash: optionalSignature,
      payinExtraId: noTag,
      payoutExtraId: noTag,
      refundExtraId: noTag,
    })
    .parse(value);
  const order = matchExchangeProviderOrder(
    {
      ...v,
      currency: 'sol',
      network: 'sol',
      fromAmount: v.expectedAmountFrom,
      toAmount: v.expectedAmountTo,
    },
    terms,
    providerId,
  );
  if (depositAddress && order.depositAddress !== depositAddress)
    throw new Error('Provider deposit address changed.');
  return {
    ...order,
    providerStatus: v.status,
    payinHash: v.payinHash || null,
    payoutHash: v.payoutHash || null,
    refundHash: v.refundHash || null,
    payoutVerified: false as const,
    refundVerified: false as const,
    ...exchangeOrderAuthority,
  };
}
