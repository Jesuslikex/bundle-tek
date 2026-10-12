import bs58 from 'bs58';
import { formatNativeBalance } from './wallet-balance-format';

const SCALE = 1_000_000_000n;
const U64_MAX = (1n << 64n) - 1n;

export type DistributionRecipient = {
  address: string;
  amount: string;
  label: string;
  sourceLines: number[];
};

export type DistributionPlan = {
  recipients: DistributionRecipient[];
  batches: DistributionRecipient[][];
  totalAmount: string;
  distributableAmount: string;
  allocationPercent: number;
  warnings: string[];
};

export function isSolanaAddress(value: string) {
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

function decimalText(value: string | number): string {
  if (typeof value === 'string') return value;
  // Compatibility for older callers and local receipts. New inputs remain strings.
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
    throw new Error('Use an exact decimal string for this amount.');
  const shortest = value.toString();
  const text = shortest.includes('e') ? value.toFixed(9) : shortest;
  if (Number(text) !== value || (text.split('.')[1]?.length ?? 0) > 9)
    throw new Error('Amount exceeds safe precision.');
  return text;
}

function atoms(value: string | number): bigint {
  const text = decimalText(value);
  if (!/^\d{1,20}(?:\.\d{1,9})?$/.test(text))
    throw new Error(
      'Use a plain decimal with up to 20 whole digits and 9 decimal places.',
    );
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(9, '0'));
}

export function canonicalDistributionAmount(value: string | number) {
  return formatNativeBalance(atoms(value).toString(), 9);
}

export function sumDistributionAmounts(values: string[]) {
  return formatNativeBalance(
    values.reduce((sum, value) => sum + atoms(value), 0n).toString(),
    9,
  );
}

export function formatDistributionAmount(value: string) {
  const [whole, fraction] = value.split('.');
  return (
    whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') +
    (fraction ? `.${fraction}` : '')
  );
}

export function toBaseUnits(amount: string | number, decimals: number) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9)
    throw new Error('Mint decimals must be between 0 and 9.');
  const raw = atoms(amount);
  if (raw === 0n) throw new Error('Transfer amount must be greater than zero.');
  const divisor = 10n ** BigInt(9 - decimals);
  if (raw % divisor !== 0n)
    throw new Error('Transfer amount exceeds precision for this mint.');
  const result = raw / divisor;
  if (result > U64_MAX)
    throw new Error('Transfer amount exceeds the SPL u64 limit.');
  return result;
}

export function buildDistributionPlan(input: {
  manifest: string;
  tokenSupply: string | number;
  reservePercent: string | number;
  batchSize: number;
}): DistributionPlan {
  const supply = atoms(input.tokenSupply);
  if (supply === 0n) throw new Error('Token supply must be greater than zero.');
  const reserve = atoms(input.reservePercent);
  if (reserve >= 100n * SCALE)
    throw new Error('Reserve must be between 0% and less than 100%.');
  if (
    !Number.isInteger(input.batchSize) ||
    input.batchSize < 1 ||
    input.batchSize > 12
  )
    throw new Error('Choose between 1 and 12 recipients per review group.');
  if (input.manifest.length > 262_144)
    throw new Error('Manifest exceeds 256 KB.');
  const byAddress = new Map<string, DistributionRecipient>();
  const warnings: string[] = [];
  let entries = 0;
  input.manifest.split(/\r?\n/).forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    if (++entries > 1_000)
      throw new Error('Use at most 1000 manifest entries.');
    const [rawAddress, rawAmount, ...rawLabel] = line
      .split(',')
      .map((part) => part.trim());
    if (!rawAddress || !rawAmount)
      throw new Error(
        `Line ${lineNumber}: expected address, amount, optional label.`,
      );
    if (!isSolanaAddress(rawAddress))
      throw new Error(`Line ${lineNumber}: invalid Solana address.`);
    let amount: string;
    try {
      amount = canonicalDistributionAmount(rawAmount);
      if (amount === '0') throw new Error('Amount must be greater than zero.');
    } catch (error) {
      throw new Error(
        `Line ${lineNumber}: ${error instanceof Error ? error.message : 'Invalid amount.'}`,
      );
    }
    const existing = byAddress.get(rawAddress);
    if (existing) {
      existing.amount = sumDistributionAmounts([existing.amount, amount]);
      existing.sourceLines.push(lineNumber);
      warnings.push(
        `Merged duplicate recipient on lines ${existing.sourceLines.join(' and ')}.`,
      );
    } else {
      byAddress.set(rawAddress, {
        address: rawAddress,
        amount,
        label: rawLabel.join(', '),
        sourceLines: [lineNumber],
      });
    }
  });
  const recipients = [...byAddress.values()];
  if (!recipients.length) throw new Error('Add at least one recipient.');
  const totalAmount = sumDistributionAmounts(
    recipients.map((recipient) => recipient.amount),
  );
  const total = atoms(totalAmount);
  // Compare rational budgets exactly, even when the reserve leaves sub-token precision.
  const allowance = supply * (100n * SCALE - reserve);
  const distributableAmount = formatNativeBalance(allowance.toString(), 20);
  if (total * 100n * SCALE > allowance)
    throw new Error(
      `Distribution exceeds the ${formatDistributionAmount(distributableAmount)} token limit after reserve.`,
    );
  const batches: DistributionRecipient[][] = [];
  for (let index = 0; index < recipients.length; index += input.batchSize)
    batches.push(recipients.slice(index, index + input.batchSize));
  return {
    recipients,
    batches,
    totalAmount,
    distributableAmount,
    // Approximation is confined to the progress bar, never amounts or authorization.
    allocationPercent: Number((total * 1_000_000n) / supply) / 10_000,
    warnings,
  };
}
