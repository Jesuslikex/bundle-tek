import type { SupplyAlert } from './supply-history';
export type SupplyAlertFilter = {
  wallet: string;
  group: 'all' | SupplyAlert['group'];
  direction: 'all' | SupplyAlert['direction'];
  minimum: string;
};
export function minimumAlertUnits(value: string, decimals: number) {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255 ||
    value.length > 277 ||
    !/^(0|[1-9]\d{0,19})(\.\d+)?$/.test(value)
  )
    throw new Error(
      'Enter a nonnegative token amount without separators or exponents.',
    );
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals)
    throw new Error(
      `This token supports ${decimals} decimal places. The threshold was not rounded.`,
    );
  const units = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (units > (1n << 64n) - 1n)
    throw new Error('Minimum movement exceeds the token unit limit.');
  return units;
}
export function matchesSupplyAlert(
  alert: SupplyAlert,
  decimals: number,
  filter: SupplyAlertFilter,
) {
  const minimum =
    filter.minimum === '' ? 0n : minimumAlertUnits(filter.minimum, decimals);
  return (
    (!filter.wallet || alert.address === filter.wallet) &&
    (filter.group === 'all' || filter.group === alert.group) &&
    (filter.direction === 'all' || filter.direction === alert.direction) &&
    BigInt(alert.raw) >= minimum
  );
}
