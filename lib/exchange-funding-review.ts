import { z } from 'zod';
import bs58 from 'bs58';

const amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .refine(
    (v) => /^(0|[1-9]\d{0,19})$/.test(v) && BigInt(v) <= (1n << 64n) - 1n,
  );
const timestamp = z
  .string()
  .refine(
    (v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v,
  );
const publicAddress = z
  .string()
  .min(32)
  .max(44)
  .refine((v) => {
    if (v.length < 32 || v.length > 44) return false;
    try {
      const bytes = bs58.decode(v);
      return bytes.length === 32 && bs58.encode(bytes) === v;
    } catch {
      return false;
    }
  });
const review = z
  .object({
    format: z.literal('exchange-funding-quote-v1'),
    provider: z.literal('ChangeNOW'),
    id: z.uuid(),
    planId: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
    revision: z.number().int().min(1).max(1e9),
    planUpdatedAt: timestamp,
    funderRevision: z.number().int().min(1).max(1e9),
    funder: publicAddress,
    network: z.literal('solana-mainnet'),
    currency: z.literal('SOL'),
    depositLamports: amount,
    expectedPayoutLamports: amount,
    providerCostLamports: amount,
    distributionTotalLamports: amount,
    undistributedPayoutLamports: amount,
    quotedAt: timestamp,
    expiresAt: timestamp,
    warning: z.string().min(1).max(2000),
    providerWarning: z.string().max(2000).nullable(),
    durableReview: z.literal(true),
    orderCreationAllowed: z.literal(false),
    fundingAllowed: z.literal(false),
    signingAllowed: z.literal(false),
    executionAllowed: z.literal(false),
  })
  .strict();
export type ExchangeFundingReview = z.infer<typeof review>;
/** Public evidence only. Never accept a bearer reference, packet or executable flag. */
export function decodeExchangeFundingReview(
  value: unknown,
): ExchangeFundingReview {
  const v = review.parse(value);
  if (
    BigInt(v.expectedPayoutLamports) <= 0n ||
    BigInt(v.distributionTotalLamports) <= 0n ||
    BigInt(v.depositLamports) - BigInt(v.expectedPayoutLamports) !==
      BigInt(v.providerCostLamports) ||
    BigInt(v.expectedPayoutLamports) - BigInt(v.distributionTotalLamports) !==
      BigInt(v.undistributedPayoutLamports) ||
    Date.parse(v.expiresAt) <= Date.parse(v.quotedAt)
  )
    throw new Error('Exchange funding review amounts or expiry do not agree.');
  return v;
}
export function exchangeSolLamports(value: string): string {
  if (!/^(0|[1-9]\d{0,9})(\.\d{1,9})?$/.test(value))
    throw new Error('Enter a positive SOL amount with up to 9 decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const raw = BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, '0'));
  if (raw <= 0n || raw > (1n << 64n) - 1n)
    throw new Error('Enter a bounded positive SOL amount.');
  return String(raw);
}
export function exchangeSolDisplay(raw: string): string {
  const valid = amount.parse(raw),
    digits = valid.padStart(10, '0'),
    fraction = digits.slice(-9).replace(/0+$/, '');
  return digits.slice(0, -9) + (fraction ? '.' + fraction : '');
}
