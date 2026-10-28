import type { AutoSellStrategyState } from './auto-sell';
import type { AutoSellRunProgress } from './auto-sell-run-progress';
import type { AutoSellRunProgressSelection } from './auto-sell-run-progress-client';

// Restoring a run from its journal is deliberately partial. The journal proves
// what was charged and which DCA draws and limit rows were consumed; it cannot
// prove the live queue, the skipped triggers or the random draws that were never
// charged. Those are reported as unavailable rather than guessed.
export const AUTO_SELL_RESTORE_UNAVAILABLE = [
  'historicalQueue',
  'skippedTriggers',
  'randomDecisions',
  'finalizedSales',
] as const;

export type AutoSellRunRestore = {
  /** Journal head at restore time, so a caller can chain new attempts. */
  head: { sequence: number; headSha256: string };
  activeAt: number;
  paused: boolean;
  stoppedReason: string | null;
  states: Map<string, AutoSellStrategyState>;
  unavailable: readonly string[];
};

const invalid = () =>
  Error(
    'The saved Auto Sell run could not be restored. Its recovery references are unchanged.',
  );

function raw(value: string) {
  if (!/^\d{1,30}$/.test(value)) throw invalid();
  return BigInt(value);
}

function time(value: string | null) {
  if (value === null) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw invalid();
  return at;
}

/**
 * Maps verified journal progress onto runner state.
 *
 * `chargedRaw` is used as the sold figure: an attempt is charged when it is
 * reserved, so counting it as sold is the conservative direction — a restored
 * run never re-sells something it already paid for. In-flight attempts stay in
 * `unresolvedAttempts` and are surfaced by the caller, not silently dropped.
 */
export function autoSellRunRestore(
  progress: AutoSellRunProgress,
  now = Date.now(),
): AutoSellRunRestore {
  if (!progress || typeof progress !== 'object') throw invalid();
  const activeAt = time(progress.run.activeAt);
  if (activeAt === null) throw invalid();
  const stoppedReason = progress.lifecycle === 'stopped' ? 'Stopped' : null;
  const paused = progress.lifecycle === 'scheduled' || activeAt > now;
  const states = new Map<string, AutoSellStrategyState>();
  for (const strategy of progress.strategies) {
    const charged = raw(strategy.chargedRaw);
    const nextDcaAt = time(strategy.nextDcaAt) ?? activeAt;
    const ended =
      strategy.lifecycle === 'expired' ||
      strategy.lifecycle === 'allowance-exhausted';
    states.set(strategy.id, {
      status: stoppedReason
        ? 'stopped'
        : ended
          ? 'ended'
          : 'running',
      endedReason: stoppedReason
        ? stoppedReason
        : strategy.lifecycle === 'expired'
          ? 'Strategy duration reached.'
          : strategy.lifecycle === 'allowance-exhausted'
            ? 'Strategy allowance exhausted.'
            : null,
      startedAt: activeAt,
      // The queue is not durable, so nothing is buffered on restore.
      bufferedRaw: 0n,
      soldRaw: charged,
      inFlightRaw: 0n,
      responses: 0,
      skipped: 0,
      nextDcaAt,
      // Limit rows already charged must never sell twice.
      filledLimitIds: [...strategy.consumedKeys],
    });
  }
  return {
    head: {
      sequence: progress.evidence.head.sequence,
      headSha256: progress.evidence.head.headSha256,
    },
    activeAt,
    paused,
    stoppedReason,
    states,
    unavailable: AUTO_SELL_RESTORE_UNAVAILABLE,
  };
}

/**
 * Loads a saved run and maps it to runner state. The caller owns the abort
 * signal; a failed load throws rather than returning a half-restored run, so a
 * caller can fall back to a clean start deliberately.
 */
export async function loadAutoSellRunRestore(
  selection: AutoSellRunProgressSelection,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<AutoSellRunRestore> {
  const { loadAutoSellRunProgress } = await import(
    './auto-sell-run-progress-client'
  );
  const progress = await loadAutoSellRunProgress(selection, signal, fetcher);
  return autoSellRunRestore(progress, now);
}