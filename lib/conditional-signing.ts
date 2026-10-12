import type { ConditionalPreparation } from './conditional-preparation-server';
import { marketUsdMicros } from './market-trigger';
import { UUID } from './wallet-operation';

// Historical captures remain readable after expiry. Only signing checks require freshness.
export function validatedConditionalSigning(
  value: unknown,
  unitsRaw: string,
  now?: number,
): ConditionalPreparation {
  const c = value as ConditionalPreparation;
  if (
    !c ||
    Object.keys(c).sort().join(',') !==
      'direction,expiresAt,format,level,observedAt,observedMarketCapUsd,orderId,orderRevision,pair,source,targetUsd,termsSha256,unitsRaw' ||
    c.format !== 'conditional-preparation-v1' ||
    !UUID.test(c.orderId) ||
    !Number.isSafeInteger(c.orderRevision) ||
    c.orderRevision < 1 ||
    c.orderRevision >= 1e9 ||
    !Number.isInteger(c.level) ||
    c.level < 1 ||
    c.level > 50 ||
    !/^[a-f0-9]{64}$/.test(c.termsSha256) ||
    typeof c.pair !== 'string' ||
    !c.pair ||
    c.pair.length > 120 ||
    !['at-or-above', 'at-or-below'].includes(c.direction) ||
    c.source !== 'api.dexscreener.com' ||
    c.unitsRaw !== unitsRaw ||
    !/^[1-9]\d{0,19}$/.test(c.unitsRaw) ||
    BigInt(c.unitsRaw) > 18446744073709551615n ||
    !Number.isFinite(Date.parse(c.observedAt)) ||
    Date.parse(c.expiresAt) !== Date.parse(c.observedAt) + 30000 ||
    (now !== undefined &&
      (Date.parse(c.observedAt) > now + 1000 || Date.parse(c.expiresAt) <= now))
  )
    throw new Error('Conditional signing capture differs or expired.');
  const target = marketUsdMicros(c.targetUsd),
    cap = marketUsdMicros(c.observedMarketCapUsd);
  if (c.direction === 'at-or-above' ? cap < target : cap > target)
    throw new Error('Captured conditional level is not met.');
  return c;
}

export function sameConditionalTerms(
  a: ConditionalPreparation,
  b: ConditionalPreparation,
) {
  return [
    'format',
    'orderId',
    'orderRevision',
    'level',
    'termsSha256',
    'pair',
    'direction',
    'targetUsd',
    'unitsRaw',
    'source',
  ].every(
    (key) =>
      a[key as keyof ConditionalPreparation] ===
      b[key as keyof ConditionalPreparation],
  );
}
