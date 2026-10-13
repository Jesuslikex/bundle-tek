import type { ConditionalPreparation } from './conditional-preparation-server';
import { marketUsdMicros } from './market-trigger';
import { UUID } from './wallet-operation';
import { walletAddress } from './wallet-workspace';
import { CONDITIONAL_BUY_INPUT_MINT } from './conditional-order';

// Historical captures remain readable after expiry. Only signing checks require freshness.
export function validatedConditionalSigning(
  value: unknown,
  unitsRaw: string,
  now?: number,
): ConditionalPreparation {
  const c = value as ConditionalPreparation;
  const buy = c?.format === 'conditional-preparation-v2';
  if (
    buy &&
    (c.side !== 'Buy' ||
      c.inputMint !== CONDITIONAL_BUY_INPUT_MINT ||
      c.inputDecimals !== 9 ||
      walletAddress(c.outputMint, 'Solana') === CONDITIONAL_BUY_INPUT_MINT ||
      !Number.isInteger(c.outputDecimals) ||
      c.outputDecimals < 0 ||
      c.outputDecimals > 255)
  )
    throw new Error('Conditional Buy denomination differs.');
  if (
    !c ||
    Object.keys(c).sort().join(',') !==
      (buy
        ? 'direction,expiresAt,format,inputDecimals,inputMint,level,observedAt,observedMarketCapUsd,orderId,orderRevision,outputDecimals,outputMint,pair,side,source,targetUsd,termsSha256,unitsRaw'
        : 'direction,expiresAt,format,level,observedAt,observedMarketCapUsd,orderId,orderRevision,pair,source,targetUsd,termsSha256,unitsRaw') ||
    (!buy && c.format !== 'conditional-preparation-v1') ||
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
  if (a.format !== b.format) return false;
  if (
    a.format === 'conditional-preparation-v2' &&
    b.format === 'conditional-preparation-v2' &&
    ['side', 'inputMint', 'inputDecimals', 'outputMint', 'outputDecimals'].some(
      (key) => a[key as keyof typeof a] !== b[key as keyof typeof b],
    )
  )
    return false;
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
export function requireConditionalSwapContext(
  value: unknown,
  context: {
    side: string;
    inputMint: string;
    outputMint: string;
    inputRaw: string;
    outputDecimals?: number;
  },
) {
  const c = validatedConditionalSigning(value, context.inputRaw);
  if (
    c.format === 'conditional-preparation-v2'
      ? context.side !== 'Buy' ||
        context.inputMint !== c.inputMint ||
        context.outputMint !== c.outputMint ||
        (context.outputDecimals !== undefined &&
          context.outputDecimals !== c.outputDecimals)
      : context.side !== 'Sell'
  )
    throw new Error(
      'Conditional side or input denomination differs from its swap.',
    );
  return c;
}
export function requireConditionalBuyOutputPrecision(
  capture: ConditionalPreparation | undefined,
  observations: { mint: string; decimals: number }[],
) {
  if (capture?.format !== 'conditional-preparation-v2') return;
  const output = observations.filter(
    (item) => item.mint === capture.outputMint,
  );
  if (output.length !== 1 || output[0].decimals !== capture.outputDecimals)
    throw new Error(
      'Conditional Buy target-token precision differs from its observed output.',
    );
}
