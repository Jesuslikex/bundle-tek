import { marketUsdMicros, reviewMarketTrigger } from './market-trigger';
import { walletAddress } from './wallet-workspace';
import { formatNativeBalance } from './wallet-balance-format';
import type { SavedTokenMarket } from './token-market';

export type DcaMarketCapRange = {
  pair: string;
  minimumUsd: string;
  maximumUsd?: string;
};

export function dcaMarketCapRange(value: unknown): DcaMarketCapRange {
  const v = value as DcaMarketCapRange;
  if (
    !v ||
    Object.keys(v).sort().join(',') !==
      (v.maximumUsd === undefined
        ? 'minimumUsd,pair'
        : 'maximumUsd,minimumUsd,pair')
  )
    throw new Error('Choose exact DCA market-cap bounds and a Solana pool.');
  const minimum =
    typeof v.minimumUsd === 'string' && /^0(?:\.0{1,6})?$/.test(v.minimumUsd)
      ? 0n
      : marketUsdMicros(v.minimumUsd);
  const maximum =
    v.maximumUsd === undefined ? undefined : marketUsdMicros(v.maximumUsd);
  if (maximum !== undefined && maximum < minimum)
    throw new Error('DCA maximum market cap must be at least its minimum.');
  return {
    pair: walletAddress(v.pair, 'Solana'),
    minimumUsd: formatNativeBalance(minimum.toString(), 6),
    ...(maximum === undefined
      ? {}
      : { maximumUsd: formatNativeBalance(maximum.toString(), 6) }),
  };
}

export function reviewDcaMarketCap(
  value: DcaMarketCapRange,
  observation: SavedTokenMarket,
  context: { chain: string; mint: string; revision: number },
  now = Date.now(),
) {
  const range = dcaMarketCapRange(value);
  const lower = reviewMarketTrigger(
    {
      pair: range.pair,
      direction: 'at-or-above',
      targetUsd: range.minimumUsd === '0' ? '0.000001' : range.minimumUsd,
    },
    observation,
    context,
    now,
  );
  const upper =
    range.maximumUsd === undefined
      ? undefined
      : reviewMarketTrigger(
          {
            pair: range.pair,
            direction: 'at-or-below',
            targetUsd: range.maximumUsd,
          },
          observation,
          context,
          now,
        );
  return {
    ...range,
    observedMarketCapUsd: lower.observedMarketCapUsd,
    observedAt: lower.observedAt,
    expiresAt: lower.expiresAt,
    met: lower.met && (upper?.met ?? true),
  };
}
