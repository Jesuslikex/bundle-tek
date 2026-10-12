import type { WarmupHistoryRun } from './warmup-history-run';
export type WarmupHistoryRunEvent = {
  runId: string;
  revision: number;
  planId: string;
  planRevision: number;
  type:
    | 'run.snapshot'
    | 'run.created'
    | 'run.pause'
    | 'run.resume'
    | 'run.cancel'
    | 'run.read_started'
    | 'run.read_recovered'
    | 'run.read_completed'
    | 'run.read_failed'
    | 'run.interrupted';
  state: WarmupHistoryRun['state'];
  completedCount: number;
  errorCount: number;
  walletAddress: string | null;
  result: WarmupHistoryRun['document']['results'][number] | null;
  createdAt: string;
};
export const historyRunEventLabel = (type: WarmupHistoryRunEvent['type']) =>
  ({
    'run.snapshot': 'Retained state before timeline tracking',
    'run.created': 'Run created',
    'run.pause': 'Run paused',
    'run.resume': 'Run resumed',
    'run.cancel': 'Run cancelled',
    'run.read_started': 'Wallet check started',
    'run.read_recovered': 'Interrupted check retried',
    'run.read_completed': 'Wallet check completed',
    'run.read_failed': 'Wallet check failed',
    'run.interrupted': 'Run interrupted by a context change',
  })[type];

export type WarmupRunActivityEvent = Omit<WarmupHistoryRunEvent, 'result'> & {
  id: string;
  name: string;
  chain: string;
  walletCount: number;
};
