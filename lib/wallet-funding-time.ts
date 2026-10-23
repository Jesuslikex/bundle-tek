import { z } from 'zod';
import bs58 from 'bs58';
const address = z
  .string()
  .max(44)
  .refine((v) => {
    try {
      return bs58.decode(v).length === 32;
    } catch {
      return false;
    }
  });
const iso = z.iso
  .datetime()
  .refine(
    (v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v,
  );
export const walletFundingSelection = z
  .object({
    wallets: z
      .array(
        z
          .object({ address, revision: z.number().int().min(1).max(1e9) })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (v) => new Set(v.wallets.map((w) => w.address)).size === v.wallets.length,
  );
export type WalletFundingSelection = z.infer<
  typeof walletFundingSelection
>['wallets'];
const funding = z
  .object({
    signature: z
      .string()
      .max(90)
      .refine((v) => {
        try {
          return bs58.decode(v).length === 64;
        } catch {
          return false;
        }
      }),
    blockTime: z.number().int().min(0).max(8640000000000),
    slot: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const walletFundingTimes = z
  .object({
    format: z.literal('wallet-funding-times-v1'),
    network: z.literal('mainnet'),
    scope: z.literal('most-recently-saved-native-transfer'),
    capturedAt: iso,
    wallets: z
      .array(
        z
          .object({
            address,
            revision: z.number().int().min(1).max(1e9),
            funding: funding.nullable(),
            reason: z
              .enum(['no-retained-receipt', 'unavailable-evidence'])
              .nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    executionAllowed: z.literal(false),
  })
  .strict()
  .superRefine((v, c) => {
    if (new Set(v.wallets.map((w) => w.address)).size !== v.wallets.length)
      c.addIssue({
        code: 'custom',
        message: 'Funding wallets are duplicated.',
      });
    for (const row of v.wallets) {
      if (
        (row.funding === null) !== (row.reason !== null) ||
        (row.funding && row.funding.blockTime * 1000 > Date.parse(v.capturedAt))
      )
        c.addIssue({
          code: 'custom',
          message: 'Funding time evidence differs.',
        });
    }
  });
export type WalletFundingTimes = z.infer<typeof walletFundingTimes>;
export function decodeWalletFundingTimes(
  value: unknown,
  selection: WalletFundingSelection,
) {
  const result = walletFundingTimes.parse(value);
  if (
    result.wallets.length !== selection.length ||
    result.wallets.some(
      (w, i) =>
        w.address !== selection[i].address ||
        w.revision !== selection[i].revision,
    )
  )
    throw Error('Funding selection changed.');
  return result;
}
export function walletFundingProximity(
  value: WalletFundingTimes,
  gapSeconds = 1800,
) {
  const result = walletFundingTimes.parse(value);
  return compareFundingEventTimes(result.wallets, gapSeconds);
}
/** Metadata-neutral comparison; each caller must first admit its own source protocol. */
export function compareFundingEventTimes(
  wallets: readonly {
    address: string;
    funding: { blockTime: number } | null;
  }[],
  gapSeconds = 1800,
  maximumWallets: 100 | 500 = 100,
) {
  if (
    (maximumWallets !== 100 && maximumWallets !== 500) ||
    wallets.length > maximumWallets ||
    new Set(wallets.map((w) => w.address)).size !== wallets.length ||
    wallets.some(
      (w) =>
        w.funding &&
        (!Number.isSafeInteger(w.funding.blockTime) ||
          w.funding.blockTime < 0 ||
          w.funding.blockTime > 8640000000000),
    )
  )
    throw Error('Invalid funding observations.');
  if (!Number.isSafeInteger(gapSeconds) || gapSeconds < 0 || gapSeconds > 86400)
    throw Error('Choose a valid funding gap.');
  const pairs: { a: string; b: string; seconds: number }[] = [];
  for (let i = 0; i < wallets.length; i++) {
    const a = wallets[i];
    if (!a.funding) continue;
    for (const b of wallets.slice(i + 1)) {
      if (!b.funding) continue;
      const seconds = Math.abs(a.funding.blockTime - b.funding.blockTime);
      if (seconds < gapSeconds)
        pairs.push({ a: a.address, b: b.address, seconds });
    }
  }
  const compare = (left: string, right: string) =>
    left === right ? 0 : left < right ? -1 : 1;
  return pairs.sort(
    (a, b) => a.seconds - b.seconds || compare(a.a, b.a) || compare(a.b, b.b),
  );
}
export function fundingGapLabel(seconds: number) {
  if (!Number.isSafeInteger(seconds) || seconds < 0)
    throw Error('Invalid funding gap.');
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}
