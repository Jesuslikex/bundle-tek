import { holdersBuyUnit } from './launch-buy';
// Captured Proxima release 20261008-180532-376bdbe.
// SHA256 4284b828a9309df4b43e02bc4ecfb6a3feaf5b5d1563e89fc4f3288b253e5b58.
// Static validation paths: computeValidationState / resolveMaxTotalBuyPercentage.
// Supply totals apply to supply-input modes. Developer bounds remain independent.
import type { LaunchPlanInput } from './launch-plan';
const PROFILES: Record<string, { total: number; developer: number }> = {
  'Arc/Argus': {
    total: 99,
    developer: 99,
  },
  'Arc/flap.sh': {
    total: 79,
    developer: 79,
  },
  'Arc/Foci': {
    total: 99,
    developer: 99,
  },
  'Arc/LIFT': {
    total: 99,
    developer: 99,
  },
  'Arc/Uniswap V4': {
    total: 99,
    developer: 99,
  },
  'Arc/Znipe': {
    total: 99,
    developer: 99,
  },
  'Base/Bankr': {
    total: 99,
    developer: 0,
  },
  'Base/Clanker': {
    total: 99,
    developer: 99,
  },
  'BNB/Flap': {
    total: 99,
    developer: 79,
  },
  'BNB/knot.fun': {
    total: 79,
    developer: 79,
  },
  'BNB/FourMeme': {
    total: 99,
    developer: 99,
  },
  'BNB/Printr': {
    total: 99,
    developer: 99,
  },
  'Ethereum/Uniswap V2': {
    total: 99,
    developer: 99,
  },
  'Ethereum/Uniswap V4': {
    total: 99,
    developer: 99,
  },
  'Robinhood/flap.sh': {
    total: 79,
    developer: 79,
  },
  'Robinhood/hood.fun': {
    total: 99,
    developer: 99,
  },
  'Robinhood/klik.finance': {
    total: 99,
    developer: 99,
  },
  'Robinhood/Livo': {
    total: 99,
    developer: 99,
  },
  'Robinhood/long.xyz': {
    total: 99,
    developer: 0,
  },
  'Robinhood/meme.bid': {
    total: 99,
    developer: 99,
  },
  'Robinhood/Noxa': {
    total: 99,
    developer: 99,
  },
  'Robinhood/o1.exchange': {
    total: 99,
    developer: 99,
  },
  'Robinhood/pons.family': {
    total: 99,
    developer: 99,
  },
  'Robinhood/pools.trade': {
    total: 99,
    developer: 99,
  },
  'Robinhood/REAL': {
    total: 99,
    developer: 99,
  },
  'Robinhood/stonks.fun': {
    total: 99,
    developer: 99,
  },
  'Robinhood/Uniswap V2': {
    total: 99,
    developer: 99,
  },
  'Robinhood/Uniswap V3': {
    total: 99,
    developer: 99,
  },
  'Robinhood/Flywheel': {
    total: 99,
    developer: 99,
  },
  'Robinhood/CoinBarrel': {
    total: 99,
    developer: 2,
  },
  'Solana/Anoncoin': {
    total: 99,
    developer: 0,
  },
  'Solana/Bags': {
    total: 79,
    developer: 79,
  },
  'Solana/LetsBonk': {
    total: 79,
    developer: 79,
  },
  'Solana/Meteora DAMM V2': {
    total: 99,
    developer: 99,
  },
  'Solana/Meteora DLMM': {
    total: 99,
    developer: 99,
  },
  'Solana/Meteora DBC': {
    total: 99,
    developer: 99,
  },
  'Solana/Printr': {
    total: 99,
    developer: 99,
  },
  'Solana/PumpFun': {
    total: 99,
    developer: 79,
  },
  'Solana/StonkFun': {
    total: 79,
    developer: 50,
  },
  'Solana/Surge': {
    total: 79,
    developer: 79,
  },
  'Solana/Stoxes': {
    total: 99,
    developer: 0,
  },
  'Solana/Lesgo': {
    total: 99,
    developer: 99,
  },
  'Solana/meme.fun': {
    total: 99,
    developer: 99,
  },
};
export function sequencedSupplyLimits(
  plan: Pick<LaunchPlanInput, 'chain' | 'launchpad' | 'mode' | 'scheduled'>,
) {
  if (holdersBuyUnit(plan) !== 'supply') return null;
  return PROFILES[`${plan.chain}/${plan.launchpad}`] ?? null;
}
export function developerSupplyLimit(
  plan: Pick<LaunchPlanInput, 'chain' | 'launchpad'>,
) {
  return PROFILES[`${plan.chain}/${plan.launchpad}`]?.developer ?? null;
}
export function validateSequencedSupply(plan: LaunchPlanInput) {
  const limits = sequencedSupplyLimits(plan);
  const developer = developerSupplyLimit(plan);
  if (developer !== null && plan.developerBuy > developer)
    throw new Error(
      developer === 0
        ? `${plan.launchpad} does not support a developer supply buy.`
        : `${plan.launchpad} developer buy allows at most ${developer}% of supply.`,
    );
  if (limits && plan.developerBuy + plan.holdersBuy > limits.total)
    throw new Error(
      `${plan.launchpad} developer and holders buys together allow at most ${limits.total}% of supply.`,
    );
}
export function developerBuyAfterPlanChange(
  current: LaunchPlanInput,
  change: Partial<LaunchPlanInput>,
  mode: LaunchPlanInput['mode'],
) {
  const next = { ...current, ...change, mode };
  const selectionChanged =
    change.chain !== undefined ||
    change.launchpad !== undefined ||
    change.mode !== undefined ||
    change.scheduled !== undefined;
  return selectionChanged && developerSupplyLimit(next) === 0
    ? 0
    : next.developerBuy;
}
