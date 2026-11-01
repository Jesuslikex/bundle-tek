// Inert per-venue capability matrix extracted from shipped Proxima release
// 20261008-180532-376bdbe. Source SHA256:
// 4284b828a9309df4b43e02bc4ecfb6a3feaf5b5d1563e89fc4f3288b253e5b58
// Static capability flags establish reference gating, not operational adapter
// support. Quote availability is deliberately not duplicated here; see
// quote-catalog.ts, which carries the same captured release.
export type VenueSwapFeature = {
  swapBack: boolean;
  timedExactIn: boolean;
  mcapLadder: boolean;
};
export type VenueToggle = { enabled: boolean };
export type VenueClaimRewards = { enabled: boolean; editShares: boolean };
export type VenueMultiLaunch = {
  enabled: boolean;
  min: number;
  max: number;
  methods: string[];
};
export type VenueLimits = {
  minHolders: number;
  maxHolders: number;
  minFrontMev: number;
  maxFrontMev: number;
  defaultBackToTempDelayMs: number;
  defaultFrontToBackDelayMs: number;
  minBuyDelayMev: number;
  maxBuyDelayMev: number;
  minBuyDelayStagger: number;
  maxBuyDelayStagger: number;
  maxMevStepDelayMs: number;
  maxTotalBuyPercentage: number;
};
export type VenueDetails = {
  descriptionOptional: boolean;
  maxSymbolLength: number;
  maxNameLength: number;
  maxCombinedLength: number;
};
export type VenueLaunchMethods = {
  block0: boolean;
  quick: boolean;
  stagger: boolean;
  manual: boolean;
  initialBuyDelay: boolean;
  initialBuyDelayMs: number;
};
export type VenueAlphaVaultOverride = {
  id: string;
  sniperGuard: VenueToggle;
  launchMethods: VenueLaunchMethods;
};
export type VenueCapabilities = {
  id: string;
  live: boolean;
  name: string;
  autoSell: VenueSwapFeature;
  autoBuy: VenueSwapFeature;
  cleanup: VenueToggle;
  sniperGuard: VenueToggle;
  volumeBot: VenueToggle;
  lock: VenueToggle;
  feeTarget: VenueToggle;
  liquidityPool: VenueToggle;
  customMint: VenueToggle;
  claimRewards: VenueClaimRewards;
  multiLaunch: VenueMultiLaunch;
  streamflowAirdrop: VenueToggle;
  redirectFees: VenueToggle;
  limits: VenueLimits;
  details: VenueDetails;
  launchMethods: VenueLaunchMethods;
  alphaVault?: VenueAlphaVaultOverride;
};
const PROFILES: Record<string, VenueCapabilities> = {
  'Solana/Anoncoin': {
    id: 'anoncoin',
    live: true,
    name: 'Anoncoin',
    autoSell: { swapBack: true, timedExactIn: true, mcapLadder: true },
    autoBuy: { swapBack: true, timedExactIn: true, mcapLadder: true },
    cleanup: { enabled: true },
    sniperGuard: { enabled: true },
    volumeBot: { enabled: true },
    lock: { enabled: true },
    feeTarget: { enabled: true },
    liquidityPool: { enabled: false },
    customMint: { enabled: true },
    claimRewards: { enabled: false, editShares: false },
    multiLaunch: { enabled: false, min: 1, max: 15, methods: [] },
    streamflowAirdrop: { enabled: false },
    redirectFees: { enabled: false },
    limits: {
      minHolders: 1,
      maxHolders: 200,
      minFrontMev: 0,
      maxFrontMev: 0,
      defaultBackToTempDelayMs: 500,
      defaultFrontToBackDelayMs: 500,
      minBuyDelayMev: 0,
      maxBuyDelayMev: 1000,
      minBuyDelayStagger: 0,
      maxBuyDelayStagger: 60000,
      maxMevStepDelayMs: 10000,
      maxTotalBuyPercentage: 99,
    },
    details: {
      descriptionOptional: false,
      maxSymbolLength: 10,
      maxNameLength: 32,
      maxCombinedLength: 99999,
    },
    launchMethods: {
      block0: true,
      quick: false,
      stagger: true,
      manual: true,
      initialBuyDelay: false,
      initialBuyDelayMs: 11000,
    },
  },
  'Solana/Bags': {
    id: 'bags',
    live: true,
    name: 'Bags',
    autoSell: { swapBack: true, timedExactIn: true, mcapLadder: true },
    autoBuy: { swapBack: true, timedExactIn: true, mcapLadder: true },
    cleanup: { enabled: true },
    sniperGuard: { enabled: true },
    volumeBot: { enabled: true },
    lock: { enabled: true },
    feeTarget: { enabled: true },
    liquidityPool: { enabled: false },
    customMint: { enabled: true },
    claimRewards: { enabled: false, editShares: false },
    multiLaunch: { enabled: false, min: 1, max: 15, methods: [] },
    streamflowAirdrop: { enabled: false },
    redirectFees: { enabled: false },
    limits: {
      minHolders: 1,
      maxHolders: 200,
      minFrontMev: 0,
      maxFrontMev: 0,
      defaultBackToTempDelayMs: 500,
      defaultFrontToBackDelayMs: 500,
      minBuyDelayMev: 0,
      maxBuyDelayMev: 1000,
      minBuyDelayStagger: 0,
      maxBuyDelayStagger: 60000,
      maxMevStepDelayMs: 10000,
      maxTotalBuyPercentage: 79,
    },
    details: {
      descriptionOptional: false,
      maxSymbolLength: 10,
      maxNameLength: 32,
      maxCombinedLength: 99999,
    },
    launchMethods: {
      block0: true,
      quick: false,
      stagger: true,
      manual: true,
      initialBuyDelay: false,
      initialBuyDelayMs: 11000,
    },
  },
  'Solana/LetsBonk': {
    id: 'bonkfun',
    live: true,
    name: 'LetsBonk',
    autoSell: { swapBack: true, timedExactIn: true, mcapLadder: true },
    autoBuy: { swapBack: true, timedExactIn: true, mcapLadder: true },
    cleanup: { enabled: true },
    sniperGuard: { enabled: true },
    volumeBot: { enabled: true },
    lock: { enabled: true },
    feeTarget: { enabled: true },
    liquidityPool: { enabled: false },
    customMint: { enabled: true },
    claimRewards: { enabled: false, editShares: false },
    multiLaunch: { enabled: false, min: 1, max: 15, methods: [] },
    streamflowAirdrop: { enabled: false },
    redirectFees: { enabled: false },
    limits: {
      minHolders: 1,
      maxHolders: 200,
      minFrontMev: 0,
      maxFrontMev: 0,
      defaultBackToTempDelayMs: 500,
      defaultFrontToBackDelayMs: 500,
      minBuyDelayMev: 0,
      maxBuyDelayMev: 1000,
      minBuyDelayStagger: 0,
      maxBuyDelayStagger: 60000,
      maxMevStepDelayMs: 10000,
      maxTotalBuyPercentage: 79,
    },
    details: {
      descriptionOptional: false,
      maxSymbolLength: 10,
      maxNameLength: 32,
      maxCombinedLength: 99999,
    },
    launchMethods: {
      block0: true,
      quick: false,
      stagger: true,
      manual: true,
      initialBuyDelay: false,
      initialBuyDelayMs: 11000,
    },
  },
  'Solana/Meteora DAMM V2': {
    id: 'meteoradamm',
    live: true,
    name: 'Meteora DAMM V2',
    autoSell: { swapBack: true, timedExactIn: true, mcapLadder: true },
    autoBuy: { swapBack: true, timedExactIn: true, mcapLadder: true },
    cleanup: { enabled: true },
    sniperGuard: { enabled: true },
    volumeBot: { enabled: true },
    lock: { enabled: true },
    feeTarget: { enabled: true },
    liquidityPool: { enabled: false },
    customMint: { enabled: true },
    claimRewards: { enabled: true, editShares: false },
    multiLaunch: { enabled: false, min: 1, max: 15, methods: [] },
    streamflowAirdrop: { enabled: false },
    redirectFees: { enabled: false },
    limits: {
      minHolders: 1,
      maxHolders: 200,
      minFrontMev: 0,
      maxFrontMev: 0,
      defaultBackToTempDelayMs: 500,
      defaultFrontToBackDelayMs: 500,
      minBuyDelayMev: 0,
      maxBuyDelayMev: 1000,
      minBuyDelayStagger: 0,
      maxBuyDelayStagger: 60000,
      maxMevStepDelayMs: 10000,
      maxTotalBuyPercentage: 99,
    },
    details: {
      descriptionOptional: true,
      maxSymbolLength: 10,
      maxNameLength: 32,
      maxCombinedLength: 99999,
    },
    launchMethods: {
      block0: true,
      quick: false,
      stagger: true,
      manual: true,
      initialBuyDelay: false,
      initialBuyDelayMs: 11000,
    },
    alphaVault: {
      id: 'alpha_vault',
      sniperGuard: { enabled: false },
      launchMethods: {
        block0: false,
        quick: false,
        stagger: true,
        manual: false,
        initialBuyDelay: false,
        initialBuyDelayMs: 11000,
      },
    },
  },
  'Solana/Meteora DLMM': {
    id: 'meteoradlmm',
    live: true,
    name: 'Meteora DLMM',
    autoSell: { swapBack: true, timedExactIn: true, mcapLadder: true },
    autoBuy: { swapBack: true, timedExactIn: true, mcapLadder: true },
    cleanup: { enabled: true },
    sniperGuard: { enabled: true },
    volumeBot: { enabled: true },
    lock: { enabled: true },
    feeTarget: { enabled: true },
    liquidityPool: { enabled: false },
    customMint: { enabled: true },
    claimRewards: { enabled: false, editShares: false },
    multiLaunch: { enabled: false, min: 1, max: 15, methods: [] },
    streamflowAirdrop: { enabled: false },
    redirectFees: { enabled: false },
    limits: {
      minHolders: 1,
      maxHolders: 200,
      minFrontMev: 0,
      maxFrontMev: 0,
      defaultBackToTempDelayMs: 500,
      defaultFrontToBackDelayMs: 500,
      minBuyDelayMev: 0,
      maxBuyDelayMev: 1000,
      minBuyDelayStagger: 0,
      maxBuyDelayStagger: 60000,
      maxMevStepDelayMs: 10000,
      maxTotalBuyPercentage: 99,
    },
    details: {
      descriptionOptional: true,
      maxSymbolLength: 10,
      maxNameLength: 32,
      maxCombinedLength: 99999,
    },
    launchMethods: {
      block0: true,
      quick: false,
      stagger: true,
      manual: true,
      initialBuyDelay: false,
      initialBuyDelayMs: 11000,
    },
    alphaVault: {
      id: 'alpha_vault',
      sniperGuard: { enabled: false },
      launchMethods: {
        block0: false,
        quick: false,
        stagger: true,
        manual: false,
        initialBuyDelay: false,
        initialBuyDelayMs: 11000,
      },
    },
  },
  'Solana/Meteora DBC': {
    id: 'meteoradbc',
    live: true,
    name: 'Meteora DBC',
    autoSell: { swapBack: true, timedExactIn: true, mcapLadder: true },
    autoBuy: { swapBack: true, timedExactIn: true, mcapLadder: true },
    cleanup: { enabled: true },
    sniperGuard: { enabled: true },
    volumeBot: { enabled: true },
    lock: { enabled: true },
    feeTarget: { enabled: true },
    liquidityPool: { enabled: false },
    customMint: { enabled: true },
    claimRewards: { enabled: false, editShares: false },
    multiLaunch: { enabled: false, min: 1, max: 15, methods: [] },
    streamflowAirdrop: { enabled: false },
    redirectFees: { enabled: false },
    limits: {
      minHolders: 1,
      maxHolders: 200,
      minFrontMev: 0,
      maxFrontMev: 0,
      defaultBackToTempDelayMs: 500,
      defaultFrontToBackDelayMs: 500,
      minBuyDelayMev: 0,
      maxBuyDelayMev: 1000,
      minBuyDelayStagger: 0,
      maxBuyDelayStagger: 60000,
      maxMevStepDelayMs: 10000,
      maxTotalBuyPercentage: 99,
    },
    details: {
      descriptionOptional: true,
      maxSymbolLength: 10,
      maxNameLength: 32,
      maxCombinedLength: 99999,
    },
    launchMethods: {
      block0: true,
      quick: false,
      stagger: true,
      manual: true,
      initialBuyDelay: false,
      initialBuyDelayMs: 11000,
    },
  },
  'Solana/Printr': {
    id: 'printr',
    live: true,
    name: 'Printr',
    autoSell: { swapBack: true, timedExactIn: true, mcapLadder: true },
    autoBuy: { swapBack: true, timedExactIn: true, mcapLadder: true },
    cleanup: { enabled: true },
    sniperGuard: { enabled: true },
    volumeBot: { enabled: true },
    lock: { enabled: true },
    feeTarget: { enabled: true },
    liquidityPool: { enabled: false },
    customMint: { enabled: true },
    claimRewards: { enabled: false, editShares: false },
    multiLaunch: { enabled: false, min: 1, max: 15, methods: [] },
    streamflowAirdrop: { enabled: false },
    redirectFees: { enabled: false },
    limits: {
      minHolders: 1,
      maxHolders: 200,
      minFrontMev: 0,
      maxFrontMev: 0,
      defaultBackToTempDelayMs: 500,
      defaultFrontToBackDelayMs: 500,
      minBuyDelayMev: 0,
      maxBuyDelayMev: 1000,
      minBuyDelayStagger: 0,
      maxBuyDelayStagger: 60000,
      maxMevStepDelayMs: 10000,
      maxTotalBuyPercentage: 99,
    },
    details: {
      descriptionOptional: false,
      maxSymbolLength: 10,
      maxNameLength: 32,
      maxCombinedLength: 99999,
    },
    launchMethods: {
      block0: true,
      quick: false,
      stagger: true,
      manual: true,
      initialBuyDelay: false,
      initialBuyDelayMs: 11000,
    },
  },
  'Solana/PumpFun': {
    id: 'pumpfun',
    live: true,
    name: 'PumpFun',
    autoSell: { swapBack: true, timedExactIn: true, mcapLadder: true },
    autoBuy: { swapBack: true, timedExactIn: true, mcapLadder: true },
    cleanup: { enabled: true },
    sniperGuard: { enabled: true },
    volumeBot: { enabled: true },
    lock: { enabled: true },
    feeTarget: { enabled: true },
    liquidityPool: { enabled: false },
    customMint: { enabled: true },
    claimRewards: { enabled: true, editShares: true },
    multiLaunch: { enabled: false, min: 1, max: 15, methods: [] },
    streamflowAirdrop: { enabled: true },
    redirectFees: { enabled: false },
    limits: {
      minHolders: 1,
      maxHolders: 200,
      minFrontMev: 0,
      maxFrontMev: 0,
      defaultBackToTempDelayMs: 500,
      defaultFrontToBackDelayMs: 500,
      minBuyDelayMev: 0,
      maxBuyDelayMev: 1000,
      minBuyDelayStagger: 0,
      maxBuyDelayStagger: 60000,
      maxMevStepDelayMs: 10000,
      maxTotalBuyPercentage: 99,
    },
    details: {
      descriptionOptional: true,
      maxSymbolLength: 13,
      maxNameLength: 32,
      maxCombinedLength: 42,
    },
    launchMethods: {
      block0: true,
      quick: false,
      stagger: true,
      manual: true,
      initialBuyDelay: false,
      initialBuyDelayMs: 11000,
    },
  },
  'Solana/StonkFun': {
    id: 'stonkfun',
    live: true,
    name: 'StonkFun',
    autoSell: { swapBack: true, timedExactIn: true, mcapLadder: true },
    autoBuy: { swapBack: true, timedExactIn: true, mcapLadder: true },
    cleanup: { enabled: true },
    sniperGuard: { enabled: true },
    volumeBot: { enabled: true },
    lock: { enabled: false },
    feeTarget: { enabled: false },
    liquidityPool: { enabled: false },
    customMint: { enabled: true },
    claimRewards: { enabled: true, editShares: false },
    multiLaunch: { enabled: false, min: 1, max: 15, methods: [] },
    streamflowAirdrop: { enabled: false },
    redirectFees: { enabled: false },
    limits: {
      minHolders: 1,
      maxHolders: 200,
      minFrontMev: 0,
      maxFrontMev: 0,
      defaultBackToTempDelayMs: 500,
      defaultFrontToBackDelayMs: 500,
      minBuyDelayMev: 0,
      maxBuyDelayMev: 1000,
      minBuyDelayStagger: 0,
      maxBuyDelayStagger: 60000,
      maxMevStepDelayMs: 10000,
      maxTotalBuyPercentage: 79,
    },
    details: {
      descriptionOptional: true,
      maxSymbolLength: 10,
      maxNameLength: 32,
      maxCombinedLength: 99999,
    },
    launchMethods: {
      block0: true,
      quick: false,
      stagger: true,
      manual: true,
      initialBuyDelay: false,
      initialBuyDelayMs: 11000,
    },
  },
  'Solana/Surge': {
    id: 'surge',
    live: true,
    name: 'Surge',
    autoSell: { swapBack: true, timedExactIn: true, mcapLadder: true },
    autoBuy: { swapBack: true, timedExactIn: true, mcapLadder: true },
    cleanup: { enabled: true },
    sniperGuard: { enabled: true },
    volumeBot: { enabled: true },
    lock: { enabled: true },
    feeTarget: { enabled: true },
    liquidityPool: { enabled: false },
    customMint: { enabled: true },
    claimRewards: { enabled: false, editShares: false },
    multiLaunch: { enabled: false, min: 1, max: 15, methods: [] },
    streamflowAirdrop: { enabled: false },
    redirectFees: { enabled: false },
    limits: {
      minHolders: 1,
      maxHolders: 200,
      minFrontMev: 0,
      maxFrontMev: 0,
      defaultBackToTempDelayMs: 500,
      defaultFrontToBackDelayMs: 500,
      minBuyDelayMev: 0,
      maxBuyDelayMev: 1000,
      minBuyDelayStagger: 0,
      maxBuyDelayStagger: 60000,
      maxMevStepDelayMs: 10000,
      maxTotalBuyPercentage: 79,
    },
    details: {
      descriptionOptional: false,
      maxSymbolLength: 10,
      maxNameLength: 32,
      maxCombinedLength: 99999,
    },
    launchMethods: {
      block0: true,
      quick: false,
      stagger: true,
      manual: true,
      initialBuyDelay: false,
      initialBuyDelayMs: 11000,
    },
  },
  'Solana/Stoxes': {
    id: 'stoxes',
    live: true,
    name: 'Stoxes',
    autoSell: { swapBack: true, timedExactIn: true, mcapLadder: true },
    autoBuy: { swapBack: true, timedExactIn: true, mcapLadder: true },
    cleanup: { enabled: true },
    sniperGuard: { enabled: true },
    volumeBot: { enabled: true },
    lock: { enabled: false },
    feeTarget: { enabled: false },
    liquidityPool: { enabled: false },
    customMint: { enabled: false },
    claimRewards: { enabled: true, editShares: false },
    multiLaunch: { enabled: false, min: 1, max: 15, methods: [] },
    streamflowAirdrop: { enabled: false },
    redirectFees: { enabled: false },
    limits: {
      minHolders: 1,
      maxHolders: 200,
      minFrontMev: 0,
      maxFrontMev: 0,
      defaultBackToTempDelayMs: 500,
      defaultFrontToBackDelayMs: 500,
      minBuyDelayMev: 0,
      maxBuyDelayMev: 1000,
      minBuyDelayStagger: 0,
      maxBuyDelayStagger: 60000,
      maxMevStepDelayMs: 10000,
      maxTotalBuyPercentage: 99,
    },
    details: {
      descriptionOptional: true,
      maxSymbolLength: 10,
      maxNameLength: 32,
      maxCombinedLength: 99999,
    },
    launchMethods: {
      block0: true,
      quick: false,
      stagger: true,
      manual: true,
      initialBuyDelay: false,
      initialBuyDelayMs: 11000,
    },
  },
  'Solana/Lesgo': {
    id: 'lesgo',
    live: true,
    name: 'Lesgo',
    autoSell: { swapBack: true, timedExactIn: true, mcapLadder: true },
    autoBuy: { swapBack: true, timedExactIn: true, mcapLadder: true },
    cleanup: { enabled: true },
    sniperGuard: { enabled: true },
    volumeBot: { enabled: true },
    lock: { enabled: true },
    feeTarget: { enabled: true },
    liquidityPool: { enabled: false },
    customMint: { enabled: true },
    claimRewards: { enabled: false, editShares: false },
    multiLaunch: { enabled: false, min: 1, max: 15, methods: [] },
    streamflowAirdrop: { enabled: false },
    redirectFees: { enabled: false },
    limits: {
      minHolders: 1,
      maxHolders: 200,
      minFrontMev: 0,
      maxFrontMev: 0,
      defaultBackToTempDelayMs: 500,
      defaultFrontToBackDelayMs: 500,
      minBuyDelayMev: 0,
      maxBuyDelayMev: 1000,
      minBuyDelayStagger: 0,
      maxBuyDelayStagger: 60000,
      maxMevStepDelayMs: 10000,
      maxTotalBuyPercentage: 99,
    },
    details: {
      descriptionOptional: true,
      maxSymbolLength: 10,
      maxNameLength: 32,
      maxCombinedLength: 99999,
    },
    launchMethods: {
      block0: true,
      quick: false,
      stagger: true,
      manual: true,
      initialBuyDelay: false,
      initialBuyDelayMs: 11000,
    },
  },
  'Solana/meme.fun': {
    id: 'memefun',
    live: true,
    name: 'meme.fun',
    autoSell: { swapBack: true, timedExactIn: true, mcapLadder: true },
    autoBuy: { swapBack: true, timedExactIn: true, mcapLadder: true },
    cleanup: { enabled: true },
    sniperGuard: { enabled: true },
    volumeBot: { enabled: true },
    lock: { enabled: true },
    feeTarget: { enabled: true },
    liquidityPool: { enabled: false },
    customMint: { enabled: true },
    claimRewards: { enabled: true, editShares: false },
    multiLaunch: { enabled: false, min: 1, max: 15, methods: [] },
    streamflowAirdrop: { enabled: false },
    redirectFees: { enabled: false },
    limits: {
      minHolders: 1,
      maxHolders: 200,
      minFrontMev: 0,
      maxFrontMev: 8,
      defaultBackToTempDelayMs: 500,
      defaultFrontToBackDelayMs: 500,
      minBuyDelayMev: 0,
      maxBuyDelayMev: 1000,
      minBuyDelayStagger: 0,
      maxBuyDelayStagger: 60000,
      maxMevStepDelayMs: 10000,
      maxTotalBuyPercentage: 99,
    },
    details: {
      descriptionOptional: true,
      maxSymbolLength: 10,
      maxNameLength: 32,
      maxCombinedLength: 99999,
    },
    launchMethods: {
      block0: true,
      quick: false,
      stagger: true,
      manual: true,
      initialBuyDelay: false,
      initialBuyDelayMs: 11000,
    },
  },
};
export const VENUE_CAPABILITY_KEYS = Object.freeze(Object.keys(PROFILES));
export function venueCapabilities(chain: string, venue: string) {
  const profile = PROFILES[`${chain}/${venue}`];
  return { profile: profile ?? null, captured: !!profile };
}
// A venue that was not captured has no known capability; callers must treat
// every toggle as unavailable rather than assuming support.
export function venueFeatureEnabled(
  chain: string,
  venue: string,
  feature: keyof Pick<
    VenueCapabilities,
    | 'cleanup'
    | 'sniperGuard'
    | 'volumeBot'
    | 'lock'
    | 'feeTarget'
    | 'liquidityPool'
    | 'customMint'
    | 'streamflowAirdrop'
    | 'redirectFees'
  >,
) {
  const { profile } = venueCapabilities(chain, venue);
  // An uncaptured venue supports nothing; never assume a toggle is on.
  return profile ? profile[feature].enabled : false;
}
export function venueCapabilityLimits(chain: string, venue: string) {
  return venueCapabilities(chain, venue).profile?.limits ?? null;
}
