import type { EvmHoldingsSnapshot } from './evm-holdings';
export type ImportedEvmBalance = {
  projectRevision: number;
  walletRevision: number;
  snapshot: EvmHoldingsSnapshot;
};
