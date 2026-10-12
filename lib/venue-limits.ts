// Inert data extracted from shipped Proxima release 20261008-180532-376bdbe.
// Source SHA256: 4284b828a9309df4b43e02bc4ecfb6a3feaf5b5d1563e89fc4f3288b253e5b58.
// Static limits establish reference validation, not operational adapter support.
export type VenueLimits = {
  maxName: number;
  maxSymbol: number;
  maxCombined: number;
  descriptionOptional: boolean;
  maxRecipients: number;
};
const PROFILES: Record<string, VenueLimits> = {
  'Arc/Argus': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Arc/flap.sh': {
    maxName: 24,
    maxSymbol: 15,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Arc/Foci': {
    maxName: 64,
    maxSymbol: 16,
    maxCombined: 99999,
    descriptionOptional: true,
    maxRecipients: 200,
  },
  'Arc/LIFT': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Arc/Uniswap V4': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Arc/Znipe': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Base/Bankr': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Base/Clanker': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'BNB/Flap': {
    maxName: 24,
    maxSymbol: 15,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'BNB/knot.fun': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: true,
    maxRecipients: 100,
  },
  'BNB/FourMeme': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'BNB/Printr': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Ethereum/Uniswap V2': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Ethereum/Uniswap V4': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Robinhood/flap.sh': {
    maxName: 24,
    maxSymbol: 15,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Robinhood/hood.fun': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 100,
  },
  'Robinhood/klik.finance': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Robinhood/Livo': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Robinhood/long.xyz': {
    maxName: 24,
    maxSymbol: 15,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Robinhood/meme.bid': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Robinhood/Noxa': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Robinhood/o1.exchange': {
    maxName: 24,
    maxSymbol: 15,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Robinhood/pons.family': {
    maxName: 64,
    maxSymbol: 16,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Robinhood/pools.trade': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Robinhood/REAL': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Robinhood/stonks.fun': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: true,
    maxRecipients: 200,
  },
  'Robinhood/Uniswap V2': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Robinhood/Uniswap V3': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Robinhood/Flywheel': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: true,
    maxRecipients: 100,
  },
  'Robinhood/CoinBarrel': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: true,
    maxRecipients: 100,
  },
  'Solana/Anoncoin': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Solana/Bags': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Solana/LetsBonk': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Solana/Meteora DAMM V2': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: true,
    maxRecipients: 200,
  },
  'Solana/Meteora DLMM': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: true,
    maxRecipients: 200,
  },
  'Solana/Meteora DBC': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: true,
    maxRecipients: 200,
  },
  'Solana/Printr': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Solana/PumpFun': {
    maxName: 32,
    maxSymbol: 13,
    maxCombined: 42,
    descriptionOptional: true,
    maxRecipients: 200,
  },
  'Solana/StonkFun': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: true,
    maxRecipients: 200,
  },
  'Solana/Surge': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: false,
    maxRecipients: 200,
  },
  'Solana/Stoxes': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: true,
    maxRecipients: 200,
  },
  'Solana/Lesgo': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: true,
    maxRecipients: 200,
  },
  'Solana/meme.fun': {
    maxName: 32,
    maxSymbol: 10,
    maxCombined: 99999,
    descriptionOptional: true,
    maxRecipients: 200,
  },
};
export function venueLimits(chain: string, venue: string) {
  const captured = PROFILES[`${chain}/${venue}`];
  return {
    ...(captured ?? {
      maxName: 32,
      maxSymbol: 13,
      maxCombined: 99999,
      descriptionOptional: true,
      maxRecipients: 200,
    }),
    verified: !!captured,
  };
}
export function validateVenuePlan(
  plan: {
    chain: string;
    launchpad: string;
    tokenName: string;
    ticker: string;
    description: string;
    holderCount: number;
  },
  requireDescription = false,
) {
  const limits = venueLimits(plan.chain, plan.launchpad);
  if (plan.tokenName.trim().length > limits.maxName)
    throw new Error(
      `${plan.launchpad} names allow at most ${limits.maxName} characters.`,
    );
  if (plan.ticker.trim().length > limits.maxSymbol)
    throw new Error(
      `${plan.launchpad} symbols allow at most ${limits.maxSymbol} characters.`,
    );
  if (
    plan.tokenName.trim().length + plan.ticker.trim().length >
    limits.maxCombined
  )
    throw new Error(
      `${plan.launchpad} name and symbol together allow at most ${limits.maxCombined} characters.`,
    );
  if (plan.holderCount > limits.maxRecipients)
    throw new Error(
      `${plan.launchpad} allows at most ${limits.maxRecipients} recipients.`,
    );
  if (
    requireDescription &&
    !limits.descriptionOptional &&
    !plan.description.trim()
  )
    throw new Error(
      `Add a description for ${plan.launchpad} before continuing.`,
    );
  return limits;
}
