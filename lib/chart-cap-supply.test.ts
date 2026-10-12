import { expect, it } from 'vitest';
import { chartCapSupply } from './chart-cap-supply';
import type { PoolCandles } from './pool-candles';
const snapshot = {
  chain: 'Solana',
  address: 'mint',
  candles: [{ open: 0.1, high: 0.2, low: 0.05, close: 0.15 }],
} as PoolCandles;
const token = {
  chain: 'Solana',
  address: 'mint',
  decimals: 6,
  totalSupplyRaw: '1000000000',
  observedAt: '2026-10-12T00:00:00Z',
};
it('converts exact atomic supply to approximate display units', () => {
  expect(chartCapSupply(snapshot, token)).toBe(1000);
});
it('rejects foreign identity and missing supply', () => {
  expect(chartCapSupply(snapshot)).toBeNull();
  expect(chartCapSupply(snapshot, { ...token, address: 'other' })).toBeNull();
  expect(chartCapSupply(snapshot, { ...token, chain: 'Ethereum' })).toBeNull();
});
it('rejects malformed, zero and out-of-range raw supplies', () => {
  for (const totalSupplyRaw of [
    '0',
    '-1',
    '1.2',
    '01',
    '18446744073709551616',
    '9'.repeat(79),
  ])
    expect(chartCapSupply(snapshot, { ...token, totalSupplyRaw })).toBeNull();
});
it('rejects invalid precision and observation dates', () => {
  for (const decimals of [-1, 1.5, 256])
    expect(chartCapSupply(snapshot, { ...token, decimals })).toBeNull();
  expect(
    chartCapSupply(snapshot, { ...token, observedAt: 'invalid' }),
  ).toBeNull();
});
it('withholds the cap scale when display arithmetic overflows or underflows', () => {
  expect(
    chartCapSupply(
      {
        ...snapshot,
        candles: [{ ...snapshot.candles[0], high: Number.MAX_VALUE }],
      },
      token,
    ),
  ).toBeNull();
  expect(
    chartCapSupply(
      {
        ...snapshot,
        candles: [{ ...snapshot.candles[0], low: Number.MIN_VALUE }],
      },
      { ...token, totalSupplyRaw: '1', decimals: 255 },
    ),
  ).toBeNull();
});
