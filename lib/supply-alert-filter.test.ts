import { expect, it } from 'vitest';
import {
  matchesSupplyAlert,
  minimumAlertUnits,
  type SupplyAlertFilter,
} from './supply-alert-filter';
import type { SupplyAlert } from './supply-history';
const filter: SupplyAlertFilter = {
  wallet: '',
  group: 'all',
  direction: 'all',
  minimum: '',
};
const alert: SupplyAlert = {
  address: 'fixture-wallet',
  group: 'team',
  direction: 'decrease',
  raw: '9007199254740993',
  amount: '9007199254.740993',
  previousRaw: '9007199254740993',
  currentRaw: '0',
};
it('compares exact raw units beyond JavaScript integer precision without rounding', () => {
  expect(
    matchesSupplyAlert(alert, 6, { ...filter, minimum: '9007199254.740993' }),
  ).toBe(true);
  expect(
    matchesSupplyAlert(alert, 6, { ...filter, minimum: '9007199254.740994' }),
  ).toBe(false);
  expect(minimumAlertUnits('0.000001', 6)).toBe(1n);
  expect(minimumAlertUnits('1', 0)).toBe(1n);
});
it('combines wallet, direction and ownership group filters', () => {
  expect(matchesSupplyAlert(alert, 6, filter)).toBe(true);
  expect(matchesSupplyAlert(alert, 6, { ...filter, wallet: 'other' })).toBe(
    false,
  );
  expect(matchesSupplyAlert(alert, 6, { ...filter, group: 'pool' })).toBe(
    false,
  );
  expect(
    matchesSupplyAlert(alert, 6, { ...filter, direction: 'increase' }),
  ).toBe(false);
  expect(
    matchesSupplyAlert(alert, 6, {
      ...filter,
      wallet: alert.address,
      group: 'team',
      direction: 'decrease',
    }),
  ).toBe(true);
});
it('rejects excess precision, unsafe syntax and overflowing unit amounts', () => {
  for (const value of ['0.0000001', '-1', '1e2', '1,000', '01', ' 1', '1.'])
    expect(() => minimumAlertUnits(value, 6)).toThrow();
  expect(() => minimumAlertUnits('18446744073709551616', 0)).toThrow();
  expect(minimumAlertUnits('18446744073709551615', 0)).toBe((1n << 64n) - 1n);
});
