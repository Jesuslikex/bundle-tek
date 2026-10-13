import { expect, it, vi } from 'vitest';
import {
  randomDcaAllocation,
  validateRandomDcaAllocation,
  dcaRandomization,
} from './dca-random-allocation';
const bounds = {
  format: 'bounded-dca-allocation-v1' as const,
  minimumRaw: '2',
  maximumRaw: '5',
  totalRaw: '11',
};
it('conserves every atom across bounded random cycles, including u64-sized budgets', () => {
  for (let n = 2; n <= 25; n++)
    for (let offset = 0; offset <= 3 * n; offset++) {
      const total = BigInt(2 * n + offset),
        values = randomDcaAllocation(
          total.toString(),
          n,
          { ...bounds, totalRaw: total.toString() },
          () => BigInt(offset * 17 + n),
        );
      expect(values.reduce((sum, x) => sum + BigInt(x), 0n)).toBe(total);
      expect(values.every((x) => BigInt(x) >= 2n && BigInt(x) <= 5n)).toBe(
        true,
      );
      expect(
        validateRandomDcaAllocation(
          total.toString(),
          n,
          { ...bounds, totalRaw: total.toString() },
          values,
        ),
      ).toEqual(values);
    }
  const maximum = ((1n << 64n) - 1n).toString();
  const large = randomDcaAllocation(
    maximum,
    25,
    { ...bounds, minimumRaw: '1', maximumRaw: maximum, totalRaw: maximum },
    () => 0n,
  );
  expect(large.reduce((sum, x) => sum + BigInt(x), 0n)).toBe(BigInt(maximum));
});
it('avoids biased modulo draws by rejecting the excess tail and does not draw for forced cycles', () => {
  const random = vi
    .fn()
    .mockReturnValueOnce((1n << 64n) - 1n)
    .mockReturnValue(0n);
  expect(
    randomDcaAllocation(
      '6',
      2,
      { ...bounds, minimumRaw: '1', maximumRaw: '5', totalRaw: '6' },
      random,
    ),
  ).toEqual(['1', '5']);
  expect(random).toHaveBeenCalledTimes(2);
  const forced = vi.fn();
  expect(
    randomDcaAllocation(
      '6',
      3,
      { ...bounds, minimumRaw: '2', maximumRaw: '2', totalRaw: '6' },
      forced,
    ),
  ).toEqual(['2', '2', '2']);
  expect(forced).not.toHaveBeenCalled();
  expect(() =>
    randomDcaAllocation(
      '6',
      2,
      { ...bounds, minimumRaw: '1', maximumRaw: '5', totalRaw: '6' },
      () => -1n,
    ),
  ).toThrow('random allocation unavailable');
  expect(() =>
    randomDcaAllocation(
      '6',
      2,
      { ...bounds, minimumRaw: '1', maximumRaw: '5', totalRaw: '6' },
      () => (1n << 64n) - 1n,
    ),
  ).toThrow('random allocation unavailable');
});
it('rejects malformed bounds, impossible budgets and changed preview allocations', () => {
  for (const b of [
    { ...bounds, minimumRaw: '0' },
    { ...bounds, minimumRaw: '6' },
    { ...bounds, maximumRaw: '01' },
    { ...bounds, maximumRaw: '18446744073709551616' },
    { ...bounds, format: 'unknown' },
    { ...bounds, other: 1 },
  ])
    expect(() => dcaRandomization(b)).toThrow();
  for (const [total, n] of [
    ['5', 3],
    ['16', 3],
    ['11', 1],
    ['11', 26],
  ] as const)
    expect(() => randomDcaAllocation(total, n, bounds)).toThrow();
  for (const values of [
    ['1', '5', '5'],
    ['2', '3', '7'],
    ['3', '3', '3'],
    ['3', '3'],
    ['03', '3', '5'],
  ])
    expect(() =>
      validateRandomDcaAllocation('11', 3, bounds, values),
    ).toThrow();
});
