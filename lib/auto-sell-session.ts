import {
  autoSellMaximumError,
  autoSellTokenCapRaw,
  percentOfRaw,
  percentUnits,
} from './auto-sell';

export type AutoSellSessionRules = {
  startDelaySeconds: number;
  endDurationSeconds: number;
  endMaxSupplyPercent: string;
  endMaxTokenAmount?: string;
};

export function autoSellSessionError(rules: AutoSellSessionRules) {
  const maximum = autoSellMaximumError(rules);
  if (maximum) return maximum;
  for (const [label, value] of [
    ['Start delay', rules.startDelaySeconds],
    ['Session duration', rules.endDurationSeconds],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 86400)
      return `${label} must be a whole number from 0 to 86400 seconds.`;
  }
  if (rules.endMaxSupplyPercent) {
    try {
      const units = percentUnits(rules.endMaxSupplyPercent);
      if (units <= 0n || units > 100_000_000n) throw new Error();
    } catch {
      return 'Session maximum must be greater than 0 and at most 100% supply.';
    }
  }
  return '';
}

export function autoSellSessionCap(
  rules: AutoSellSessionRules,
  supply: bigint,
  decimals?: number,
) {
  const error = autoSellSessionError(rules);
  if (error) throw new Error(error);
  const tokens = autoSellTokenCapRaw(rules, supply, decimals);
  if (rules.endMaxTokenAmount !== undefined) return tokens;
  if (!rules.endMaxSupplyPercent) return null;
  const cap = percentOfRaw(supply, rules.endMaxSupplyPercent);
  if (cap <= 0n)
    throw new Error('Session maximum is smaller than one token unit.');
  return cap;
}
