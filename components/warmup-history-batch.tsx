'use client';
import { useEffect, useRef, useState } from 'react';
import {
  createWarmupHistoryBatch,
  type WarmupBatchState,
} from '@/lib/warmup-history-batch';
import type { WarmupHistoryRun } from '@/lib/warmup-history-run';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
import { Button } from './ui/button';
export function WarmupHistoryBatch({
  run,
  plan,
  disabled,
  onRun,
  onActive,
}: {
  run: WarmupHistoryRun;
  plan: SavedWarmup;
  disabled: boolean;
  onRun: (run: WarmupHistoryRun) => void;
  onActive: (id: string, active: boolean) => void;
}) {
  const controller = useRef<ReturnType<typeof createWarmupHistoryBatch> | null>(
    null,
  );
  const [state, setState] = useState<WarmupBatchState | null>(null);
  useEffect(() => {
    const current = createWarmupHistoryBatch({
      runId: run.id,
      planId: plan.id,
      planRevision: plan.revision,
      available: () => !document.hidden && navigator.onLine && !plan.archived,
      read: async (signal) => {
        const response = await fetch(
          `/api/wallet-workspace/warmup/runs?planId=${encodeURIComponent(plan.id)}`,
          {
            cache: 'no-store',
            signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
          },
        );
        const data = (await response.json()) as {
          planId: string;
          executionAllowed: boolean;
          runs: WarmupHistoryRun[];
        };
        if (
          !response.ok ||
          data.planId !== plan.id ||
          data.executionAllowed !== false ||
          !Array.isArray(data.runs)
        )
          throw new Error(
            'Saved history run unavailable. Reload before retrying.',
          );
        const selected = data.runs.find((row) => row.id === run.id);
        if (!selected)
          throw new Error(
            'Saved history run unavailable. Reload before retrying.',
          );
        return selected;
      },
      advance: async (saved, signal) => {
        const response = await fetch('/api/wallet-workspace/warmup/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
          body: JSON.stringify({
            action: 'advance',
            id: saved.id,
            revision: saved.revision,
          }),
        });
        if (response.status === 429) return null;
        const data = (await response.json()) as {
          run: WarmupHistoryRun;
          executionAllowed: boolean;
          error?: string;
        };
        if (!response.ok)
          throw new Error(
            data.error ||
              'Public check interrupted. Reload saved progress before retrying.',
          );
        if (data.executionAllowed !== false || !data.run)
          throw new Error(
            'Invalid history check response. Reload saved progress.',
          );
        return data.run;
      },
      onRun,
      onState: (next) => {
        setState(next);
        onActive(run.id, ['reading', 'waiting'].includes(next.status));
      },
    });
    controller.current = current;
    const availability = () => current.visibilityChanged();
    document.addEventListener('visibilitychange', availability);
    window.addEventListener('offline', availability);
    return () => {
      current.destroy();
      onActive(run.id, false);
      document.removeEventListener('visibilitychange', availability);
      window.removeEventListener('offline', availability);
      if (controller.current === current) controller.current = null;
    };
  }, [run.id, plan.id, plan.revision, plan.archived, onRun, onActive]);
  const active =
    state !== null && ['reading', 'waiting'].includes(state.status);
  return (
    <section aria-label="Automatic public history checks">
      <Button
        variant="outline"
        disabled={
          disabled ||
          active ||
          run.planRevision !== plan.revision ||
          plan.archived
        }
        onClick={() => controller.current?.start()}
      >
        Check remaining wallets
      </Button>
      <Button
        variant="outline"
        disabled={!active}
        onClick={() => controller.current?.stop()}
      >
        Stop automatic checks
      </Button>
      <p>
        Checks each remaining public address in this saved run, waiting at least
        15 seconds between reads. Keep this panel visible and online. Hidden
        tabs, errors or closing the panel stop automatic checks. Restart
        explicitly to continue saved progress. An in-flight read may still
        finish. No trades are scheduled.
      </p>
      {state && (
        <output aria-live="polite">
          Automatic checks: {state.status} ·{' '}
          {state.total > 0
            ? `${state.checked}/${state.total} checked.`
            : 'Loading saved progress.'}{' '}
          {state.reason}
        </output>
      )}
    </section>
  );
}
