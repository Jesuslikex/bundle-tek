// Captured public frontend configuration, release 20261008-180532-376bdbe.
// SHA256: 4284b828a9309df4b43e02bc4ecfb6a3feaf5b5d1563e89fc4f3288b253e5b58
// Static planning capabilities do not establish executable adapter support.
import type { LaunchMode, LaunchPlanInput } from './launch-plan';
type MethodProfile = {
  methods: LaunchMode[];
  initialBuyDelayMs: number | null;
};
const PROFILES: Record<string, MethodProfile> = {
  'Solana/Anoncoin': {
    methods: ['Block-0', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Solana/Bags': {
    methods: ['Block-0', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Solana/LetsBonk': {
    methods: ['Block-0', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Solana/Meteora DAMM V2': {
    methods: ['Block-0', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Solana/Meteora DLMM': {
    methods: ['Block-0', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Solana/Meteora DBC': {
    methods: ['Block-0', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Solana/Printr': {
    methods: ['Block-0', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Solana/PumpFun': {
    methods: ['Block-0', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Solana/StonkFun': {
    methods: ['Block-0', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Solana/Surge': {
    methods: ['Block-0', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Solana/Stoxes': {
    methods: ['Block-0', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Solana/Lesgo': {
    methods: ['Block-0', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Solana/meme.fun': {
    methods: ['Block-0', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Robinhood/flap.sh': {
    methods: ['Block-0', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Robinhood/hood.fun': {
    methods: ['Block-0', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Robinhood/klik.finance': {
    methods: ['Quick', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Robinhood/Livo': {
    methods: ['Quick', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Robinhood/long.xyz': {
    methods: ['Quick', 'Stagger', 'Manual'],
    initialBuyDelayMs: 11000,
  },
  'Robinhood/meme.bid': {
    methods: ['Block-0', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Robinhood/Noxa': {
    methods: ['Quick', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Robinhood/o1.exchange': {
    methods: ['Quick', 'Stagger', 'Manual'],
    initialBuyDelayMs: 11000,
  },
  'Robinhood/pons.family': {
    methods: ['Block-0', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Robinhood/pools.trade': {
    methods: ['Quick', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Robinhood/REAL': {
    methods: ['Quick', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Robinhood/stonks.fun': {
    methods: ['Quick', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Robinhood/Uniswap V2': {
    methods: ['Quick', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Robinhood/Uniswap V3': {
    methods: ['Quick', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Robinhood/Flywheel': {
    methods: ['Quick', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Robinhood/CoinBarrel': {
    methods: ['Quick', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Arc/Argus': {
    methods: ['Quick', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Arc/flap.sh': {
    methods: ['Block-0', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Arc/Foci': {
    methods: ['Quick', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Arc/LIFT': {
    methods: ['Quick', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Arc/Uniswap V4': {
    methods: ['Quick', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Arc/Znipe': {
    methods: ['Quick', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Base/Bankr': {
    methods: ['Quick', 'Stagger', 'Manual'],
    initialBuyDelayMs: 11000,
  },
  'Base/Clanker': {
    methods: ['Quick', 'Stagger', 'Manual'],
    initialBuyDelayMs: 11000,
  },
  'BNB/Flap': {
    methods: ['Block-0', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'BNB/knot.fun': {
    methods: ['Quick', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'BNB/FourMeme': {
    methods: ['Block-0', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'BNB/Printr': {
    methods: ['Block-0', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Ethereum/Uniswap V2': {
    methods: ['Block-0', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
  'Ethereum/Uniswap V4': {
    methods: ['Block-0', 'Stagger', 'Manual'],
    initialBuyDelayMs: null,
  },
};

export function venueLaunchMethods(chain: string, venue: string) {
  const profile = PROFILES[`${chain}/${venue}`];
  return {
    ...(profile ?? {
      methods: ['Manual'] as LaunchMode[],
      initialBuyDelayMs: null,
    }),
    captured: !!profile,
  };
}

export function validateLaunchMethod(
  plan: Pick<LaunchPlanInput, 'chain' | 'launchpad' | 'mode'>,
) {
  const profile = venueLaunchMethods(plan.chain, plan.launchpad);
  if (!profile.methods.includes(plan.mode))
    throw new Error(
      `${plan.launchpad} does not support ${plan.mode === 'Block-0' ? 'Sequenced' : plan.mode} in its captured launch-method profile. Select ${profile.methods.join(', ')}.`,
    );
  return profile;
}

// Explicit venue changes choose a supported method if the old one cannot carry
// over. Loading an existing project never rewrites its recorded mode.
export function modeAfterVenueChange(
  current: Pick<LaunchPlanInput, 'chain' | 'launchpad' | 'mode'>,
  change: Partial<LaunchPlanInput>,
): LaunchMode {
  if (change.mode !== undefined) return change.mode;
  if (change.chain === undefined && change.launchpad === undefined)
    return current.mode;
  const profile = venueLaunchMethods(
    change.chain ?? current.chain,
    change.launchpad ?? current.launchpad,
  );
  return profile.methods.includes(current.mode)
    ? current.mode
    : profile.methods[0];
}
