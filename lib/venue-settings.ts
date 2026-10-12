import { quoteAsset } from './quote-catalog';
import type { LaunchPlanInput } from './launch-plan';
import bs58 from 'bs58';
import { validatePrintrSettings, type PrintrSettings } from './printr-settings';
export type PumpfunSettings = {
  creatorFeePercent?: string;
  holderRewards: boolean;
  offchainCreation: boolean;
  feeSharing: boolean;
  feeShares: { address: string; shareBps: number }[];
};
export type VenueSettings = {
  printr?: PrintrSettings;
  pumpfun: PumpfunSettings;
  flap: { buyTaxPercent: number; sellTaxPercent: number };
};
export const DEFAULT_VENUE_SETTINGS: VenueSettings = {
  pumpfun: {
    holderRewards: false,
    offchainCreation: false,
    feeSharing: false,
    feeShares: [],
  },
  flap: { buyTaxPercent: 1, sellTaxPercent: 1 },
};

export function percentToBasisPoints(value: string) {
  const basisPoints = Number(value) * 100;
  const rounded = Math.round(basisPoints);
  return Math.abs(basisPoints - rounded) < 1e-8 ? rounded : basisPoints;
}
// Captured useLaunchpadFormFields resets conflicting options at each toggle.
export function updatePumpfun(
  current: PumpfunSettings,
  change: Partial<PumpfunSettings>,
): PumpfunSettings {
  const next = { ...current, ...change };
  if (change.holderRewards === true)
    return {
      ...next,
      offchainCreation: false,
      feeSharing: false,
      feeShares: [],
    };
  if (change.feeSharing === true || change.offchainCreation === true)
    next.holderRewards = false;
  if (change.feeSharing === false) next.feeShares = [];
  return next;
}
export function validateVenueSettings(
  value: unknown,
  chain: string,
  venue: string,
  quoteAddress?: string,
): VenueSettings {
  if (value === undefined) return structuredClone(DEFAULT_VENUE_SETTINGS);
  if (!value || typeof value !== 'object')
    throw new Error('Invalid venue settings.');
  const raw = value as VenueSettings,
    p = raw.pumpfun,
    f = raw.flap;
  const printr = validatePrintrSettings(raw.printr, chain, venue);
  if (
    !p ||
    !f ||
    [p.holderRewards, p.offchainCreation, p.feeSharing].some(
      (v) => typeof v !== 'boolean',
    )
  )
    throw new Error('Invalid venue toggles.');
  if (p.holderRewards && (p.offchainCreation || p.feeSharing))
    throw new Error(
      'Holder rewards cannot be combined with offchain creation or fee sharing.',
    );
  if (!Array.isArray(p.feeShares) || p.feeShares.length > 10)
    throw new Error('Use at most 10 fee recipients.');
  const creatorFeePercent = parsePumpCreatorFee(p.creatorFeePercent);
  if (
    creatorFeePercent !== undefined &&
    !pumpCreatorFeeEligible({
      chain: chain as LaunchPlanInput['chain'],
      launchpad: venue,
      quoteAddress,
    })
  )
    throw new Error(
      'Custom creator fees require a captured PumpFun quote other than SOL or canonical USDC.',
    );
  const seen = new Set<string>();
  const shares = p.feeShares.map((leg) => {
    if (typeof leg?.address !== 'string')
      throw new Error('Fee recipient public address required.');
    const address = leg.address.trim();
    try {
      if (bs58.decode(address).length !== 32) throw new Error();
    } catch {
      throw new Error('Invalid Solana fee recipient address.');
    }
    if (seen.has(address)) throw new Error('Fee recipients must be unique.');
    seen.add(address);
    if (
      !Number.isSafeInteger(leg.shareBps) ||
      leg.shareBps < 1 ||
      leg.shareBps > 10000
    )
      throw new Error(
        'Fee percentages must be positive with at most two decimal places.',
      );
    return { address, shareBps: leg.shareBps };
  });
  if (
    p.feeSharing &&
    (!shares.length || shares.reduce((sum, s) => sum + s.shareBps, 0) !== 10000)
  )
    throw new Error('Fee shares must total exactly 100%.');
  if (!p.feeSharing && shares.length)
    throw new Error('Enable fee sharing before adding recipients.');
  if (
    (chain !== 'Solana' || venue !== 'PumpFun') &&
    (p.holderRewards || p.offchainCreation || p.feeSharing)
  )
    throw new Error('PumpFun options require the Solana PumpFun profile.');
  if (
    [f.buyTaxPercent, f.sellTaxPercent].some(
      (v) =>
        typeof v !== 'number' ||
        !Number.isFinite(v) ||
        v < 0 ||
        v > 10 ||
        Math.abs(v * 100 - Math.round(v * 100)) > 1e-8,
    )
  )
    throw new Error('Flap taxes must be 0 to 10% with at most two decimals.');
  if (
    ['Flap', 'flap.sh'].includes(venue) &&
    f.buyTaxPercent === 0 &&
    f.sellTaxPercent === 0
  )
    throw new Error('Flap buy and sell tax cannot both be zero.');
  return {
    ...(printr !== undefined ? { printr } : {}),
    pumpfun: {
      ...(creatorFeePercent !== undefined ? { creatorFeePercent } : {}),
      holderRewards: p.holderRewards,
      offchainCreation: p.offchainCreation,
      feeSharing: p.feeSharing,
      feeShares: shares,
    },
    flap: { buyTaxPercent: f.buyTaxPercent, sellTaxPercent: f.sellTaxPercent },
  };
}

export function pumpCreatorFeeEligible(
  plan: Pick<LaunchPlanInput, 'chain' | 'launchpad' | 'quoteAddress'>,
) {
  const quote =
    plan.quoteAddress &&
    quoteAsset(plan.chain, plan.launchpad, plan.quoteAddress);
  return (
    plan.chain === 'Solana' &&
    plan.launchpad === 'PumpFun' &&
    !!quote &&
    ![
      'So11111111111111111111111111111111111111112',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    ].includes(quote.address)
  );
}
export function parsePumpCreatorFee(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value))
    throw new Error(
      'Creator fee must be a percentage with at most two decimal places.',
    );
  const bps = percentToBasisPoints(value);
  if (!Number.isSafeInteger(bps) || bps < 1 || bps > 300)
    throw new Error('Creator fee must be from 0.01% to 3%.');
  return String(bps / 100);
}
