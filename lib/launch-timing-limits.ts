// Inert captured launch delay bounds. Source SHA256 4284b828a9309df4b43e02bc4ecfb6a3feaf5b5d1563e89fc4f3288b253e5b58
export const LAUNCH_TIMING_LIMITS: Record<
  string,
  {
    sequencedMinMs: number;
    sequencedMaxMs: number;
    staggerMinMs: number;
    staggerMaxMs: number;
  }
> = {
  'Solana/Anoncoin': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Solana/Bags': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Solana/LetsBonk': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Solana/Meteora DAMM V2': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Solana/Meteora DLMM': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Solana/Meteora DBC': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Solana/Printr': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Solana/PumpFun': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Solana/StonkFun': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Solana/Surge': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Solana/Stoxes': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Solana/Lesgo': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Solana/meme.fun': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Base/Bankr': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Base/Clanker': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'BNB/Flap': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'BNB/knot.fun': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'BNB/FourMeme': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'BNB/Printr': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Ethereum/Uniswap V2': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Ethereum/Uniswap V4': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Arc/Argus': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Arc/flap.sh': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Arc/Foci': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Arc/LIFT': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Arc/Uniswap V4': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Arc/Znipe': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Robinhood/flap.sh': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Robinhood/hood.fun': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Robinhood/klik.finance': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Robinhood/Livo': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Robinhood/long.xyz': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Robinhood/meme.bid': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Robinhood/Noxa': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Robinhood/o1.exchange': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Robinhood/pons.family': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Robinhood/pools.trade': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Robinhood/REAL': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Robinhood/stonks.fun': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Robinhood/Uniswap V2': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Robinhood/Uniswap V3': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Robinhood/Flywheel': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
  'Robinhood/CoinBarrel': {
    sequencedMinMs: 0,
    sequencedMaxMs: 1000,
    staggerMinMs: 0,
    staggerMaxMs: 60000,
  },
};
