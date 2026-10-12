import type { WarmupInput } from './wallet-warmup';
export type SavedWarmup = {
  id: string;
  revision: number;
  archived: boolean;
  updatedAt: string;
  document: WarmupInput & {
    name: string;
    walletRevisions: Array<{ address: string; revision: number }>;
    totalBudget: string;
  };
};
export type WarmupPlanEvent = {
  id: string;
  planId: string;
  type: 'plan.create' | 'plan.save' | 'plan.archive' | 'plan.restore';
  revision: number;
  document: SavedWarmup['document'];
  createdAt: string;
};
export type WarmupActivityEvent = Omit<WarmupPlanEvent, 'document'> & {
  summary: {
    name: string;
    chain: string;
    walletCount: number;
    cycles: number;
    amount: string;
    totalBudget: string;
  };
};
