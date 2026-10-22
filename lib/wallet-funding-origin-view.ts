import { z } from 'zod';
import bs58 from 'bs58';
import {
  walletFundingSelection,
  type WalletFundingSelection,
} from './wallet-funding-time';
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
const uint = z
  .string()
  .regex(/^[1-9]\d{0,19}$/)
  .refine((v) => BigInt(v) < 1n << 64n);
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
    slot: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    transactionIndex: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    blockTime: z.number().int().min(0).max(8640000000000),
    recipientChangeRaw: uint,
    funders: z
      .array(address)
      .min(1)
      .max(32)
      .refine((v) => new Set(v).size === v.length),
  })
  .strict();
export const fundingOriginBatchSelection = z
  .object({
    wallets: walletFundingSelection.shape.wallets.max(10),
    context: walletFundingSelection.shape.wallets,
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.wallets.map((w) => w.address)).size === v.wallets.length &&
      new Set(v.context.map((w) => w.address)).size === v.context.length &&
      v.wallets.every((w) =>
        v.context.some(
          (c) => c.address === w.address && c.revision === w.revision,
        ),
      ),
  );
export const fundingOriginBatch = z
  .object({
    format: z.literal('wallet-funding-origins-v1'),
    network: z.literal('mainnet'),
    scope: z.literal('oldest-provider-reported-transaction'),
    ledgerMetadata: z.literal('provider-reported'),
    historyComplete: z.literal(false),
    signingAllowed: z.literal(false),
    executionAllowed: z.literal(false),
    context: walletFundingSelection.shape.wallets,
    capturedAt: z.iso.datetime().refine((v) => new Date(v).toISOString() === v),
    wallets: z
      .array(
        z
          .object({
            address,
            revision: z.number().int().min(1).max(1e9),
            funding: funding.nullable(),
            reason: z
              .enum([
                'no-returned-history',
                'unavailable-oldest-evidence',
                'unsupported-native-transaction',
                'not-zero-to-positive-funding',
                'unsupported-address',
              ])
              .nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      new Set(v.context.map((w) => w.address)).size !== v.context.length ||
      v.wallets.some(
        (w) =>
          !v.context.some(
            (c) => c.address === w.address && c.revision === w.revision,
          ),
      )
    )
      c.addIssue({ code: 'custom', message: 'Funding context differs.' });
    if (new Set(v.wallets.map((w) => w.address)).size !== v.wallets.length)
      c.addIssue({ code: 'custom', message: 'Duplicate wallet.' });
    for (const w of v.wallets)
      if (
        (w.funding === null) !== (w.reason !== null) ||
        (w.funding && w.funding.blockTime * 1000 > Date.parse(v.capturedAt))
      )
        c.addIssue({ code: 'custom', message: 'Funding evidence differs.' });
  });
export type FundingOriginBatch = z.infer<typeof fundingOriginBatch>;
export function decodeFundingOriginBatch(
  value: unknown,
  selection: WalletFundingSelection,
  context: WalletFundingSelection = selection,
) {
  const result = fundingOriginBatch.parse(value);
  if (
    result.context.length !== context.length ||
    result.context.some(
      (w, i) =>
        w.address !== context[i].address || w.revision !== context[i].revision,
    ) ||
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
