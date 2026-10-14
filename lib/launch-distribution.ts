// Captured HoldersBuyDeviationModal (4495130), buildHoldersPlan (4468185)
// and generateRandomArrayWithSum (4470403), release 20261008-180532-376bdbe.
// Local seeded preview and exact remainder allocation are our implementation.
import type { LaunchPlanInput } from './launch-plan';
import {
  holdersBuyUnit,
  holdersQuoteDecimals,
  parseHoldersQuoteAmount,
} from './launch-buy';

export type HolderDistribution = {
  kind: 'random' | 'single' | 'custom';
  weights?: string[];
  deviationPercent: number;
  seed: string;
};

export function parseHolderDistribution(
  value: unknown,
): HolderDistribution | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid holder distribution.');
  const raw = value as HolderDistribution;
  if (!['random', 'single', 'custom'].includes(raw.kind))
    throw new Error(
      'Choose a random, one-wallet or custom-weight distribution.',
    );
  // Local storage/preview bound. The reference input does not establish a finite maximum.
  if (
    typeof raw.deviationPercent !== 'number' ||
    !Number.isFinite(raw.deviationPercent) ||
    raw.deviationPercent < 0 ||
    raw.deviationPercent > 1000000
  )
    throw new Error('Distribution deviation must be from 0 to 1000000%.');
  if (typeof raw.seed !== 'string' || !/^[a-f0-9]{32}$/.test(raw.seed))
    throw new Error('Invalid distribution seed.');
  let weights: string[] | undefined;
  if (raw.kind === 'custom') {
    if (
      !Array.isArray(raw.weights) ||
      raw.weights.length < 1 ||
      raw.weights.length > 200
    )
      throw new Error(
        'Custom weights need 1 to 200 values, one per holder slot.',
      );
    weights = raw.weights.map((value) => {
      const amount = parseHoldersQuoteAmount(value);
      if (amount === undefined)
        throw new Error(
          'Each custom weight must be a non-negative decimal string.',
        );
      return amount;
    });
    if (weights.every((value) => value === '0'))
      throw new Error('At least one custom weight must be greater than zero.');
  }
  return {
    kind: raw.kind,
    ...(weights ? { weights } : {}),
    deviationPercent: raw.deviationPercent,
    seed: raw.seed,
  };
}

function seededRandom(seed: string) {
  let state = 2166136261;
  for (const character of seed)
    state = Math.imul(state ^ character.charCodeAt(0), 16777619) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function distributionWeights(config: HolderDistribution, count: number) {
  if (config.kind === 'custom') {
    if (config.weights?.length !== count)
      throw new Error(
        'Custom weights must match the holder count. Update the list explicitly.',
      );
    const decimals = Math.max(
      ...config.weights.map((value) => value.split('.')[1]?.length ?? 0),
    );
    return config.weights.map((value) => decimalAtoms(value, decimals));
  }
  const random = seededRandom(config.seed);
  if (config.kind === 'single') {
    const chosen = Math.floor(random() * count);
    return Array.from({ length: count }, (_, index) =>
      index === chosen ? 1n : 0n,
    );
  }
  const deviation = config.deviationPercent / 100;
  if (deviation === 0) return Array<bigint>(count).fill(1n);
  const weights = Array.from({ length: count }, () => {
    const sample = random();
    const weight =
      deviation > 1
        ? Math.pow(sample, deviation)
        : 1 - deviation + sample * 2 * deviation;
    return weight;
  });
  const maximum = Math.max(...weights);
  return maximum > 0
    ? weights.map((weight) =>
        BigInt(Math.round((weight / maximum) * 1000000000000)),
      )
    : Array<bigint>(count).fill(1n);
}

export function splitExactAtoms(total: bigint, weights: bigint[]) {
  if (total < 0n || !weights.length || weights.some((weight) => weight < 0n))
    throw new Error('Invalid allocation weights.');
  const sum = weights.reduce((value, weight) => value + weight, 0n);
  if (sum === 0n)
    throw new Error('Allocation weights must have a positive total.');
  const amounts = weights.map((weight) => (total * weight) / sum);
  const remainders = weights
    .map((weight, index) => ({ index, remainder: (total * weight) % sum }))
    .sort((a, b) =>
      a.remainder === b.remainder
        ? a.index - b.index
        : a.remainder > b.remainder
          ? -1
          : 1,
    );
  const missing = Number(
    total - amounts.reduce((value, amount) => value + amount, 0n),
  );
  for (let index = 0; index < missing; index++)
    amounts[remainders[index].index] += 1n;
  return amounts;
}

/** Apply the saved seed/weights to actual base units, rather than rounded preview percentages. */
export function allocateHolderBaseUnits(plan: LaunchPlanInput, total: bigint) {
  const config = parseHolderDistribution(plan.holdersDistribution);
  if (
    !config ||
    !Number.isInteger(plan.holderCount) ||
    plan.holderCount < 1 ||
    plan.holderCount > 200
  )
    throw new Error('Save an explicit distribution for 1 to 200 holder slots.');
  return splitExactAtoms(total, distributionWeights(config, plan.holderCount));
}

function decimalAtoms(value: string, decimals: number) {
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals)
    throw new Error('Allocation amount exceeds the selected precision.');
  return BigInt(whole + fraction.padEnd(decimals, '0'));
}
function decimalString(value: bigint, decimals: number) {
  if (decimals === 0) return value.toString();
  const text = value.toString().padStart(decimals + 1, '0');
  const fraction = text.slice(-decimals).replace(/0+$/, '');
  return text.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}
function supplyDecimal(value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 100)
    throw new Error('Invalid holders supply percentage.');
  const [coefficient, exponent] = String(value).split('e');
  if (exponent === undefined) return coefficient;
  const [whole, fraction = ''] = coefficient.split('.');
  const digits = whole + fraction,
    point = whole.length + Number(exponent);
  return point <= 0
    ? '0.' + '0'.repeat(-point) + digits
    : point >= digits.length
      ? digits + '0'.repeat(point - digits.length)
      : digits.slice(0, point) + '.' + digits.slice(point);
}

export function previewHolderDistribution(plan: LaunchPlanInput) {
  const config = parseHolderDistribution(plan.holdersDistribution);
  if (!config) return null;
  if (
    !Number.isInteger(plan.holderCount) ||
    plan.holderCount < 1 ||
    plan.holderCount > 200
  )
    throw new Error('Distribution needs 1 to 200 holders.');
  const unit = holdersBuyUnit(plan);
  const amount =
    unit === 'supply'
      ? supplyDecimal(plan.holdersBuy)
      : parseHoldersQuoteAmount(plan.holdersBuyQuote);
  if (amount === undefined)
    throw new Error(
      'Enter a holders quote amount to preview its distribution.',
    );
  const decimals =
    unit === 'supply'
      ? Math.max(12, amount.split('.')[1]?.length ?? 0)
      : holdersQuoteDecimals(plan);
  if (decimals === null)
    throw new Error(
      'Select a captured quote token to preview its distribution.',
    );
  const total = decimalAtoms(amount, decimals);
  const atoms = splitExactAtoms(
    total,
    distributionWeights(config, plan.holderCount),
  );
  return {
    unit: unit === 'supply' ? '%' : plan.currency,
    total: decimalString(total, decimals),
    decimals,
    items: atoms.map((value, index) => ({
      index,
      amount: decimalString(value, decimals),
    })),
  };
}
