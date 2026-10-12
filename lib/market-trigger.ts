import type { SavedTokenMarket } from './token-market';
import { formatNativeBalance } from './wallet-balance-format';
const maximum = BigInt(Number.MAX_SAFE_INTEGER);
export function marketUsdMicros(value: unknown): bigint {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,9})(\.\d{1,6})?$/.test(value)
  )
    throw new Error('Use a positive USD amount with at most six decimals.');
  const [whole, fraction = ''] = value.split('.'),
    raw = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (raw <= 0n || raw > maximum)
    throw new Error('USD target exceeds the supported exact range.');
  return raw;
}
export type MarketTrigger = {
  pair: string;
  direction: 'at-or-above' | 'at-or-below';
  targetUsd: string;
};
export function reviewMarketTrigger(
  trigger: MarketTrigger,
  observation: SavedTokenMarket,
  context: { chain: string; mint: string; revision: number },
  now: number = Date.now(),
) {
  const target = marketUsdMicros(trigger.targetUsd);
  if (
    !trigger.pair ||
    !['at-or-above', 'at-or-below'].includes(trigger.direction) ||
    !observation ||
    observation.executionAllowed !== false ||
    observation.source !== 'api.dexscreener.com' ||
    observation.chain !== context.chain ||
    observation.address !== context.mint ||
    observation.projectRevision !== context.revision ||
    !Number.isSafeInteger(context.revision) ||
    context.revision < 1 ||
    !Number.isFinite(now)
  )
    throw new Error('Market condition context differs.');
  const time = Date.parse(observation.observedAt);
  if (!Number.isFinite(time) || time > now + 1000 || time + 30000 <= now)
    throw new Error(
      'Refresh the market observation before reviewing this condition.',
    );
  const pairs = observation.pairs.filter((p) => p.address === trigger.pair);
  if (pairs.length !== 1)
    throw new Error('The selected pool is missing or ambiguous.');
  const cap = pairs[0].marketCapUsd;
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0)
    throw new Error('Market cap is unavailable for this pool.');
  const current = marketUsdMicros(String(cap));
  return {
    executionAllowed: false as const,
    pair: trigger.pair,
    direction: trigger.direction,
    targetUsd: formatNativeBalance(target.toString(), 6),
    observedMarketCapUsd: formatNativeBalance(current.toString(), 6),
    met:
      trigger.direction === 'at-or-above'
        ? current >= target
        : current <= target,
    observedAt: observation.observedAt,
    expiresAt: new Date(time + 30000).toISOString(),
    source: observation.source,
  };
}
export function marketGrid(input: {
  minimumUsd: string;
  maximumUsd: string;
  lines: number;
  totalRaw: string;
  decimals: number;
}) {
  const min = marketUsdMicros(input.minimumUsd),
    max = marketUsdMicros(input.maximumUsd);
  if (
    !Number.isInteger(input.lines) ||
    input.lines < 2 ||
    input.lines > 50 ||
    max <= min ||
    max - min < BigInt(input.lines - 1) ||
    !Number.isInteger(input.decimals) ||
    input.decimals < 0 ||
    input.decimals > 255 ||
    typeof input.totalRaw !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(input.totalRaw) ||
    BigInt(input.totalRaw) > 18446744073709551615n ||
    BigInt(input.totalRaw) < BigInt(input.lines)
  )
    throw new Error(
      'Use 2 to 50 distinct increasing grid levels and at least one atomic unit per level.',
    );
  const total = BigInt(input.totalRaw),
    count = BigInt(input.lines),
    base = total / count;
  return Array.from({ length: input.lines }, (_, i) => {
    const units = base + (i === input.lines - 1 ? total % count : 0n);
    return {
      level: i + 1,
      targetUsd: formatNativeBalance(
        (min + ((max - min) * BigInt(i)) / BigInt(input.lines - 1)).toString(),
        6,
      ),
      unitsRaw: units.toString(),
      amount: formatNativeBalance(units.toString(), input.decimals),
    };
  });
}
