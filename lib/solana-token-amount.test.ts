import { expect, it } from 'vitest';
import { solanaTokenAtoms } from './solana-token-amount';
it('preserves exact token units through the full u64 range', () => {
  expect(solanaTokenAtoms('0.000001', 6)).toBe(1n);
  expect(solanaTokenAtoms('18446744073709.551615', 6)).toBe((1n << 64n) - 1n);
  expect(solanaTokenAtoms('18446744073709551615', 0)).toBe((1n << 64n) - 1n);
  expect(solanaTokenAtoms('0.' + '0'.repeat(254) + '1', 255)).toBe(1n);
});
it('rejects rounding, nonpositive, scientific and out-of-range token amounts', () => {
  for (const [value, decimals] of [
    ['0.0000001', 6],
    ['18446744073709.551616', 6],
    ['0', 6],
    ['-1', 6],
    ['1e-6', 6],
    ['1.0', 0],
    ['1', 256],
    ['1', -1],
    ['1', 1.1],
    ['1', NaN],
  ] as Array<[string, number]>)
    expect(() => solanaTokenAtoms(value, decimals)).toThrow();
});
