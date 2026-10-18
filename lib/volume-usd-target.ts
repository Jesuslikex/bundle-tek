import { z } from 'zod';
import type { TokenMarket } from './token-market';

export const VOLUME_USD_LIFETIME_MS = 60_000;
export const VOLUME_NATIVE_MINT = 'So11111111111111111111111111111111111111112';
const money = /^(0|[1-9]\d{0,11})(?:\.\d{1,2})?$/;
const price = /^(0|[1-9]\d{0,29})(?:\.\d{1,60})?$/;
const atom = (text: string) => {
  const [whole, fraction = ''] = text.split('.');
  return {
    raw: BigInt(whole + fraction),
    scale: 10n ** BigInt(fraction.length),
  };
};

/** Round upward by at most one lamport, without Number-based money arithmetic. */
export function volumeUsdToLamports(usd: string, solUsd: string) {
  if (typeof usd !== 'string' || !money.test(usd))
    throw new Error(
      'Enter a positive USD target with at most two decimal places.',
    );
  if (typeof solUsd !== 'string' || !price.test(solUsd))
    throw new Error('SOL/USD market price is invalid.');
  const amount = atom(usd),
    quote = atom(solUsd);
  if (amount.raw === 0n || quote.raw === 0n)
    throw new Error('USD target and SOL/USD price must be positive.');
  const numerator = amount.raw * quote.scale * 1_000_000_000n;
  const denominator = amount.scale * quote.raw;
  const result = (numerator + denominator - 1n) / denominator;
  if (result < 2_000_000n || result > 9_999_999_999_999_999_999n)
    throw new Error(
      'Converted target must cover a 0.001 SOL round trip and fit the Volume Bot limit.',
    );
  return result.toString();
}

const quoteSchema = z
  .object({
    format: z.literal('volume-usd-target-v1'),
    id: z.uuid(),
    projectId: z.string().min(1).max(100),
    projectRevision: z.number().int().positive(),
    nativeMint: z.literal(VOLUME_NATIVE_MINT),
    source: z.literal('api.dexscreener.com'),
    pair: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
    liquidityUsd: z.number().positive(),
    targetUsd: z.string().regex(money),
    solPriceUsd: z.string().regex(price),
    targetVolumeLamports: z.string().regex(/^[1-9]\d{0,18}$/),
    observedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    executionAllowed: z.literal(false),
    signingAllowed: z.literal(false),
  })
  .strict();
export type VolumeUsdTarget = z.infer<typeof quoteSchema>;

export function validateVolumeUsdTarget(value: unknown): VolumeUsdTarget {
  const quote = quoteSchema.parse(value);
  if (
    volumeUsdToLamports(quote.targetUsd, quote.solPriceUsd) !==
      quote.targetVolumeLamports ||
    new Date(quote.observedAt).toISOString() !== quote.observedAt ||
    new Date(quote.expiresAt).toISOString() !== quote.expiresAt ||
    Date.parse(quote.expiresAt) - Date.parse(quote.observedAt) !==
      VOLUME_USD_LIFETIME_MS
  )
    throw new Error('USD conversion evidence differs from its exact target.');
  return quote;
}

export function captureVolumeUsdTarget(
  input: {
    id: string;
    projectId: string;
    projectRevision: number;
    targetUsd: string;
  },
  observation: TokenMarket,
  now: number,
) {
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(Date.parse(observation.observedAt)) ||
    observation.chain !== 'Solana' ||
    observation.address !== VOLUME_NATIVE_MINT ||
    observation.source !== 'api.dexscreener.com' ||
    observation.executionAllowed !== false ||
    Date.parse(observation.observedAt) > now ||
    now - Date.parse(observation.observedAt) >= VOLUME_USD_LIFETIME_MS
  )
    throw new Error('A fresh server SOL/USD market observation is required.');
  const pair = [...observation.pairs]
    .filter((p) => p.priceUsd && p.liquidityUsd !== null && p.liquidityUsd > 0)
    .sort(
      (a, b) =>
        b.liquidityUsd! - a.liquidityUsd! || a.address.localeCompare(b.address),
    )[0];
  if (!pair?.priceUsd)
    throw new Error('No liquid SOL/USD market price is available.');
  return validateVolumeUsdTarget({
    ...input,
    format: 'volume-usd-target-v1',
    nativeMint: VOLUME_NATIVE_MINT,
    source: observation.source,
    pair: pair.address,
    liquidityUsd: pair.liquidityUsd,
    solPriceUsd: pair.priceUsd,
    targetVolumeLamports: volumeUsdToLamports(input.targetUsd, pair.priceUsd),
    observedAt: observation.observedAt,
    expiresAt: new Date(
      Date.parse(observation.observedAt) + VOLUME_USD_LIFETIME_MS,
    ).toISOString(),
    executionAllowed: false,
    signingAllowed: false,
  });
}
