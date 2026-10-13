import { expect, it } from 'vitest';
import { dcaSupplyInput, dcaSupplySizing } from './dca-supply-sizing';
const token = {
  chain: 'Solana',
  address: 'So11111111111111111111111111111111111111112',
  decimals: 6,
  totalSupplyRaw: '17',
  observedAt: '2026-10-13T12:00:00.000Z',
};
it('rounds a captured total down while enforcing conservative per-cycle percentage bounds', () => {
  const sized = dcaSupplyInput(token, {
    totalPercent: '50.000000',
    minimumPercent: '10',
    maximumPercent: '30',
  });
  expect(sized.totalRaw).toBe('8');
  expect(sized.minimumRaw).toBe('2');
  expect(sized.maximumRaw).toBe('5');
  expect(sized.sizing.totalPercent).toBe('50');
  expect(
    dcaSupplyInput(
      { ...token, totalSupplyRaw: '18446744073709551615' },
      { totalPercent: '100' },
    ).totalRaw,
  ).toBe('18446744073709551615');
  const supply = 18446744073709551615n;
  expect(
    dcaSupplyInput(
      { ...token, totalSupplyRaw: supply.toString() },
      { totalPercent: '97.543210' },
    ).totalRaw,
  ).toBe(((supply * 97543210n) / 100000000n).toString());
});
it('rejects invalid percentages, dust budgets, empty atom ranges and incomplete captures', () => {
  for (const totalPercent of [
    '0',
    '-1',
    '100.000001',
    '1e2',
    '01',
    '0.1234567',
    '0.000001',
  ])
    expect(() => dcaSupplyInput(token, { totalPercent })).toThrow();
  expect(() =>
    dcaSupplyInput(token, {
      totalPercent: '50',
      minimumPercent: '10',
      maximumPercent: '10',
    }),
  ).toThrow('no valid');
  expect(() =>
    dcaSupplyInput(token, { totalPercent: '50', minimumPercent: '10' }),
  ).toThrow();
  for (const bad of [
    { ...token, totalSupplyRaw: '0' },
    { ...token, totalSupplyRaw: '18446744073709551616' },
    { ...token, observedAt: 'bad' },
    { ...token, chain: 'Ethereum' },
  ])
    expect(() => dcaSupplyInput(bad, { totalPercent: '50' })).toThrow();
});
it('binds supply units to the exact saved mint, supply value and observation', () => {
  const { sizing } = dcaSupplyInput(token, { totalPercent: '50' });
  expect(dcaSupplySizing(sizing, token).totalRaw).toBe('8');
  for (const bad of [
    { ...sizing, mint: '11111111111111111111111111111111' },
    { ...sizing, totalSupplyRaw: '18' },
    { ...sizing, observedAt: '2026-10-13T12:01:00.000Z' },
    { ...sizing, other: true },
  ])
    expect(() => dcaSupplySizing(bad, token)).toThrow();
});
