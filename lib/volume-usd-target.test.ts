import { expect, it } from 'vitest';
import {
  captureVolumeUsdTarget,
  validateVolumeUsdTarget,
  volumeUsdToLamports,
  VOLUME_NATIVE_MINT,
} from './volume-usd-target';
import type { TokenMarket } from './token-market';
const now = Date.parse('2026-10-18T12:00:00.000Z');
const input = {
  id: '00000000-0000-4000-8000-000000000001',
  projectId: 'p1',
  projectRevision: 3,
  targetUsd: '100.01',
};
export function market(at = new Date().toISOString()): TokenMarket {
  return {
    chain: 'Solana',
    address: VOLUME_NATIVE_MINT,
    source: 'api.dexscreener.com',
    observedAt: at,
    returnedPairCount: 1,
    quoteOnlyPairCount: 0,
    executionAllowed: false,
    pairs: [
      {
        address: VOLUME_NATIVE_MINT,
        dex: 'synthetic',
        url: 'https://dexscreener.com/solana/' + VOLUME_NATIVE_MINT,
        quoteSymbol: 'USDC',
        priceUsd: '200',
        liquidityUsd: 100000,
        volume24hUsd: null,
        change24h: null,
        marketCapUsd: null,
      },
    ],
  };
}
it.each([
  ['100', '200', '500000000'],
  ['100.01', '200', '500050000'],
  ['1', '3', '333333334'],
  ['999999999999.99', '1000000', '999999999999990'],
])('converts %s at %s with exact upward rounding', (usd, price, expected) =>
  expect(volumeUsdToLamports(usd, price)).toBe(expected),
);
it.each(['0', '-1', '1e2', ' 1', '01', '1.001', '1000000000000'])(
  'refuses invalid or nonpositive USD %s',
  (usd) => expect(() => volumeUsdToLamports(usd, '200')).toThrow(),
);
it.each(['0', '-1', 'NaN', '1e2', 'Infinity'])(
  'refuses invalid price %s',
  (price) => expect(() => volumeUsdToLamports('100', price)).toThrow(),
);
it('refuses targets outside the SOL limits', () => {
  expect(() => volumeUsdToLamports('0.01', '200')).toThrow();
  expect(() => volumeUsdToLamports('100', '0.0000000001')).toThrow();
});
it('retains the most liquid available price and exact expiry without authority', () => {
  const m = market(new Date(now).toISOString());
  m.pairs.unshift({ ...m.pairs[0], liquidityUsd: 1, priceUsd: '1' });
  const q = captureVolumeUsdTarget(input, m, now);
  expect(q.solPriceUsd).toBe('200');
  expect(q.targetVolumeLamports).toBe('500050000');
  expect(q.expiresAt).toBe('2026-10-18T12:01:00.000Z');
  expect(q.signingAllowed).toBe(false);
  expect(validateVolumeUsdTarget(q)).toEqual(q);
});
it.each([-60000, 1])('refuses stale or future observations (%s)', (offset) =>
  expect(() =>
    captureVolumeUsdTarget(
      input,
      market(new Date(now + offset).toISOString()),
      now,
    ),
  ).toThrow(),
);
it('refuses missing liquid prices and malformed times', () => {
  const m = market();
  m.pairs = [];
  expect(() => captureVolumeUsdTarget(input, m, now)).toThrow();
  expect(() => captureVolumeUsdTarget(input, market('bad'), now)).toThrow();
});
it('refuses altered conversion, expiry, authority and extra fields', () => {
  const q = captureVolumeUsdTarget(
    input,
    market(new Date(now).toISOString()),
    now,
  );
  for (const change of [
    { targetVolumeLamports: '500050001' },
    { expiresAt: '2026-10-18T12:02:00.000Z' },
    { signingAllowed: true },
    { extra: true },
  ])
    expect(() => validateVolumeUsdTarget({ ...q, ...change })).toThrow();
});
