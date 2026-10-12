import type { WarmupHistory } from './wallet-warmup';
export type WarmupHistoryRun = {
  id: string;
  planId: string;
  planRevision: number;
  state: 'planned' | 'running' | 'paused' | 'cancelled' | 'completed';
  revision: number;
  leaseUntil: number | null;
  createdAt: string;
  updatedAt: string;
  document: {
    chain: string;
    wallets: Array<{ address: string; revision: number }>;
    results: Array<{
      address: string;
      observation?: WarmupHistory;
      error?: string;
    }>;
  };
};
export type HistoryRunRow = Omit<WarmupHistoryRun, 'document'> & {
  document: string;
};
export const HISTORY_RUN_COLUMNS =
  'id,plan_id AS planId,plan_revision AS planRevision,state,revision,lease_until AS leaseUntil,created_at AS createdAt,updated_at AS updatedAt,document';
export function historyRun(row: HistoryRunRow): WarmupHistoryRun {
  return { ...row, document: JSON.parse(row.document) };
}
export function historyRunNext(run: WarmupHistoryRun) {
  return run.document.wallets.find(
    (w) => !run.document.results.some((r) => r.address === w.address),
  );
}
export function historyRunControl(
  state: WarmupHistoryRun['state'],
  action: string,
): WarmupHistoryRun['state'] | null {
  if (action === 'pause' && (state === 'planned' || state === 'running'))
    return 'paused';
  if (action === 'resume' && state === 'paused') return 'planned';
  if (action === 'cancel' && ['planned', 'running', 'paused'].includes(state))
    return 'cancelled';
  return null;
}
