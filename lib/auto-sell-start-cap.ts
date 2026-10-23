import {
  endCapRaw,
  minimumAutoSellRaw,
  rawToDecimal,
  type AutoSellStrategy,
} from './auto-sell';

/** Pre-run feedback only. Running/paused edits use their retained accounting. */
export function autoSellStartCapError(
  strategy: AutoSellStrategy,
  totalSupplyRaw: bigint,
  decimals: number,
  sessionCap: bigint | null,
) {
  const minimum = minimumAutoSellRaw(strategy, totalSupplyRaw);
  const ownCap = endCapRaw(strategy, totalSupplyRaw, decimals);
  if (minimum <= 0n) return null;
  for (const [label, cap] of [
    ['strategy', ownCap],
    ['session', sessionCap],
  ] as const) {
    if (cap !== null && cap < minimum)
      return `Minimum sell is ${rawToDecimal(minimum, decimals)} tokens, but the ${label} maximum is ${rawToDecimal(cap, decimals)} tokens. Increase that maximum or lower the minimum before starting.`;
  }
  return null;
}
