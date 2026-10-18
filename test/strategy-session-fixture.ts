import type {
  StrategyContext,
  StrategySessionInput,
} from '../lib/strategy-session-plan';
export const strategyProject = '00000000-0000-4000-8000-000000000001';
export const strategyWallet = '11111111111111111111111111111111';
export const strategySecond = 'So11111111111111111111111111111111111111112';
export const strategyContext = (): StrategyContext => ({
  projectId: strategyProject,
  projectRevision: 1,
  token: {
    chain: 'Solana',
    address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
    symbol: 'USDC',
  },
  wallets: [
    { chain: 'Solana', address: strategyWallet, revision: 1, archived: false },
    { chain: 'Solana', address: strategySecond, revision: 2, archived: false },
  ],
});
export const strategyInput = (): StrategySessionInput => ({
  name: 'Two strategies',
  projectId: strategyProject,
  projectRevision: 1,
  side: 'Buy',
  startAt: '2026-10-18T12:00:00.000Z',
  maxAmount: '0.03',
  durationSeconds: 600,
  strategies: [
    {
      id: '00000000-0000-4000-8000-000000000002',
      wallet: strategyWallet,
      walletRevision: 1,
      maxAmount: '0.02',
      durationSeconds: 300,
      kind: 'DCA',
      amountPerCycle: '0.005',
      cycles: 5,
      intervalSeconds: 60,
    },
    {
      id: '00000000-0000-4000-8000-000000000003',
      wallet: strategySecond,
      walletRevision: 2,
      maxAmount: '0.02',
      durationSeconds: 900,
      kind: 'Limit',
      amount: '0.01',
      marketCapUsd: '100000',
      direction: 'at-or-above',
    },
  ],
});
