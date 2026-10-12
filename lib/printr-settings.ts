export const PRINTR_FEE_DESTINATIONS = [
  { value: 'stake_pool', label: 'Staking pool' },
  { value: 'dev', label: 'Creator' },
  { value: 'buyback', label: 'Buyback & burn' },
] as const;
export const PRINTR_SUPPLIES = [
  { value: '100_million', label: '100 million' },
  { value: '1_billion', label: '1 billion' },
  { value: '10_billion', label: '10 billion' },
] as const;
export type PrintrSettings = {
  feeDestination: (typeof PRINTR_FEE_DESTINATIONS)[number]['value'];
  maxSupply: (typeof PRINTR_SUPPLIES)[number]['value'];
  initialMarketCapUsd: string;
  beforeMigrationFeePercent: string;
  afterMigrationFeePercent: string;
};
export const DEFAULT_PRINTR_SETTINGS: PrintrSettings = {
  feeDestination: 'stake_pool',
  maxSupply: '1_billion',
  initialMarketCapUsd: '',
  beforeMigrationFeePercent: '1',
  afterMigrationFeePercent: '0.01',
};

function fee(value: unknown, maxBps: number, label: string) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value))
    throw new Error(`${label} must have at most two decimal places.`);
  const [whole, fraction = ''] = value.split('.');
  const bps = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (bps < 1n || bps > BigInt(maxBps))
    throw new Error(`${label} must be from 0.01% to ${maxBps / 100}%.`);
  return String(Number(bps) / 100);
}

export function validatePrintrSettings(
  value: unknown,
  chain: string,
  venue: string,
): PrintrSettings | undefined {
  if (value === undefined) return undefined;
  if (chain !== 'Solana' || venue !== 'Printr')
    throw new Error('Printr settings require the Solana Printr profile.');
  if (!value || typeof value !== 'object')
    throw new Error('Invalid Printr settings.');
  const raw = value as PrintrSettings;
  if (
    !PRINTR_FEE_DESTINATIONS.some(
      (option) => option.value === raw.feeDestination,
    )
  )
    throw new Error('Choose a captured Printr fee destination.');
  if (!PRINTR_SUPPLIES.some((option) => option.value === raw.maxSupply))
    throw new Error('Choose a captured Printr supply preset.');
  const cap = raw.initialMarketCapUsd;
  if (
    typeof cap !== 'string' ||
    (cap !== '' &&
      (!/^(0|[1-9]\d{0,14})(\.\d{1,2})?$/.test(cap) || Number(cap) < 5000))
  )
    throw new Error(
      'Initial market cap must be empty or at least $5,000, with at most two decimals and 15 whole digits.',
    );
  const [whole, fraction = ''] = cap.split('.');
  const canonicalFraction = fraction.replace(/0+$/, '');
  return {
    feeDestination: raw.feeDestination,
    maxSupply: raw.maxSupply,
    initialMarketCapUsd:
      cap === ''
        ? ''
        : whole + (canonicalFraction ? `.${canonicalFraction}` : ''),
    beforeMigrationFeePercent: fee(
      raw.beforeMigrationFeePercent,
      150,
      'Fee before migration',
    ),
    afterMigrationFeePercent: fee(
      raw.afterMigrationFeePercent,
      140,
      'Fee after migration',
    ),
  };
}
