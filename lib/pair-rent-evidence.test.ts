import { expect, it } from 'vitest';
import {
  inspectPairRentAccount,
  pairRentMinimumRaw,
} from './pair-rent-evidence';
import { pairRentAccount } from '../test/pair-rent-fixture';
// Independent read-only mainnet capture, 2026-10-15T23:34:14Z, cross-checked against six rent RPC sizes.
it.each([
  [0, '650240'],
  [82, '1066800'],
  [165, '1488440'],
  [179, '1559560'],
  [200, '1666240'],
  [4096, '21457920'],
] as const)(
  'matches captured Rent and independent RPC for size %i',
  (size, expected) => {
    const rent = inspectPairRentAccount({
      owner: 'Sysvar1111111111111111111111111111111111111',
      executable: false,
      lamports: '1009200',
      space: '17',
      data: ['2BMAAAAAAAAAAAAAAADwPzI=', 'base64'],
    });
    expect(pairRentMinimumRaw(rent, size)).toBe(expected);
  },
);
it.each([
  [3480n, 2, '2039280'],
  [6960n, 1, '2039280'],
  [0n, 1, '1'],
  [0n, 2, '1'],
] as const)(
  'supports exact legacy/current profiles and Bank minimum, rate=%s threshold=%s',
  (rate, threshold, expected) => {
    expect(
      pairRentMinimumRaw(
        inspectPairRentAccount(pairRentAccount(rate, threshold)),
        165,
      ),
    ).toBe(expected);
  },
);
it.each([NaN, Infinity, -1, 0, 1.5, 3])(
  'rejects unsupported threshold %s',
  (threshold) => {
    expect(() =>
      inspectPairRentAccount(pairRentAccount(10n, threshold)),
    ).toThrow();
  },
);
it.each([
  'missing',
  'owner',
  'executable',
  'lamports',
  'overflow',
  'space',
  'encoding',
  'length',
  'burn',
  'rate-one',
  'rate-two',
] as const)('rejects %s Rent evidence', (mode) => {
  const raw = pairRentAccount();
  if (mode === 'owner') raw.owner = '11111111111111111111111111111111';
  if (mode === 'executable') raw.executable = true;
  if (mode === 'lamports') raw.lamports = '01';
  if (mode === 'overflow') raw.lamports = '18446744073709551616';
  if (mode === 'space') raw.space = '18';
  if (mode === 'encoding') raw.data[1] = 'base58';
  if (mode === 'length') raw.data[0] += 'AAAA';
  if (mode === 'burn') raw.data = pairRentAccount(10n, 1, 101).data;
  if (mode === 'rate-one') raw.data = pairRentAccount(1759197129868n, 1).data;
  if (mode === 'rate-two') raw.data = pairRentAccount(879598564934n, 2).data;
  expect(() =>
    inspectPairRentAccount(mode === 'missing' ? null : raw),
  ).toThrow();
});
it.each([-1, 0.5, 4097, NaN, Infinity])(
  'refuses unsupported account size %s',
  (size) => {
    expect(() =>
      pairRentMinimumRaw(inspectPairRentAccount(pairRentAccount()), size),
    ).toThrow();
  },
);
