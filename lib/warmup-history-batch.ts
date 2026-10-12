import type { WarmupHistoryRun } from './warmup-history-run';
export type WarmupBatchState = {
  runId: string;
  status: 'reading' | 'waiting' | 'stopped' | 'completed' | 'error';
  checked: number;
  total: number;
  reason: string;
};
export function createWarmupHistoryBatch(options: {
  runId: string;
  planId: string;
  planRevision: number;
  available: () => boolean;
  read: (signal: AbortSignal) => Promise<WarmupHistoryRun>;
  advance: (
    run: WarmupHistoryRun,
    signal: AbortSignal,
  ) => Promise<WarmupHistoryRun | null>;
  onRun: (run: WarmupHistoryRun) => void;
  onState: (state: WarmupBatchState) => void;
}) {
  let generation = 0,
    enabled = false,
    checked = 0,
    total = 0,
    lastRevision = 0;
  let pending: AbortController | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  let walletSnapshot: string | null = null;
  let resultAddresses: string[] = [];
  const clear = () => {
    generation++;
    clearTimeout(timer);
    pending?.abort();
    pending = undefined;
  };
  const publish = (status: WarmupBatchState['status'], reason = '') =>
    options.onState({ runId: options.runId, status, checked, total, reason });
  const accept = (run: WarmupHistoryRun) => {
    if (
      run.id !== options.runId ||
      run.planId !== options.planId ||
      run.planRevision !== options.planRevision ||
      !Number.isSafeInteger(run.revision) ||
      run.revision < 1 ||
      run.revision < lastRevision ||
      !['planned', 'running', 'paused', 'cancelled', 'completed'].includes(
        run.state,
      ) ||
      (run.state === 'completed' &&
        run.document?.results.length !== run.document?.wallets.length) ||
      !Array.isArray(run.document?.wallets) ||
      run.document.wallets.length < 1 ||
      run.document.wallets.length > 20 ||
      !Array.isArray(run.document.results) ||
      run.document.results.length > run.document.wallets.length ||
      new Set(run.document.wallets.map((w) => w.address)).size !==
        run.document.wallets.length ||
      new Set(run.document.results.map((r) => r.address)).size !==
        run.document.results.length ||
      run.document.results.some(
        (r) => !run.document.wallets.some((w) => w.address === r.address),
      ) ||
      (run.leaseUntil !== null &&
        (!Number.isSafeInteger(run.leaseUntil) || run.leaseUntil < 0))
    )
      throw new Error(
        'Saved run changed or has invalid progress. Reload before continuing.',
      );
    const snapshot = JSON.stringify([run.document.chain, run.document.wallets]);
    if (
      (walletSnapshot !== null && snapshot !== walletSnapshot) ||
      resultAddresses.some(
        (address, index) => run.document.results[index]?.address !== address,
      )
    )
      throw new Error(
        'Captured wallets or retained progress changed. Reload before continuing.',
      );
    walletSnapshot = snapshot;
    resultAddresses = run.document.results.map((result) => result.address);
    checked = run.document.results.length;
    lastRevision = run.revision;
    total = run.document.wallets.length;
    options.onRun(run);
    if (run.state === 'completed') {
      if (checked !== total)
        throw new Error('Completed run has incomplete results.');
      enabled = false;
      publish(
        'completed',
        'All requested checks finished. Review any provider failures.',
      );
      return false;
    }
    if (!['planned', 'running'].includes(run.state)) {
      enabled = false;
      publish(
        'stopped',
        'Run is paused or cancelled. Resume it explicitly before continuing.',
      );
      return false;
    }
    if (checked === total)
      throw new Error('Saved run has no remaining wallet. Reload its status.');
    return true;
  };
  const wait = (
    run: number,
    delay = 15000,
    reason = 'Waiting between public wallet reads.',
  ) => {
    publish('waiting', reason);
    timer = setTimeout(() => void tick(run), delay);
  };
  async function tick(g: number) {
    if (!enabled || g !== generation || pending) return;
    if (!options.available()) {
      enabled = false;
      clear();
      publish(
        'stopped',
        'Panel hidden or browser offline. Restart explicitly to continue saved progress.',
      );
      return;
    }
    const c = new AbortController();
    pending = c;
    publish('reading');
    try {
      const run = await options.read(c.signal);
      if (g !== generation || c.signal.aborted) return;
      if (!accept(run)) {
        pending = undefined;
        return;
      }
      if (!options.available())
        throw new Error('Panel hidden or browser offline. Restart explicitly.');
      if (run.leaseUntil !== null && run.leaseUntil > Date.now()) {
        pending = undefined;
        wait(
          g,
          Math.max(15000, Math.min(45000, run.leaseUntil - Date.now() + 1000)),
          'An existing wallet read still holds its lease. Waiting for saved progress.',
        );
        return;
      }
      const next = await options.advance(run, c.signal);
      if (g !== generation || c.signal.aborted) return;
      pending = undefined;
      if (next === null) {
        wait(
          g,
          15000,
          'Wallet read rate limit reached. Waiting before retrying saved progress.',
        );
        return;
      }
      if (
        next.revision <= run.revision ||
        next.document.results.length <= run.document.results.length
      )
        throw new Error('Run did not advance. Reload before retrying.');
      if (accept(next)) wait(g);
    } catch (e) {
      if (g !== generation || c.signal.aborted) return;
      enabled = false;
      clear();
      publish(
        'error',
        e instanceof Error
          ? e.message
          : 'Public check interrupted. Reload saved progress before retrying.',
      );
    }
  }
  return {
    start() {
      if (enabled) return;
      clear();
      enabled = true;
      void tick(generation);
    },
    stop() {
      enabled = false;
      clear();
      publish(
        'stopped',
        'Automatic checking stopped. An in-flight server read may still finish; reload saved progress before restarting.',
      );
    },
    visibilityChanged() {
      if (enabled && !options.available()) this.stop();
    },
    destroy() {
      enabled = false;
      clear();
    },
  };
}
