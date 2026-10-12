'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createRetainedRunStatusFeed,
  type RetainedRunFeedState,
} from '@/lib/retained-run-status-feed';
import { WarmupHistoryRunTimeline } from './warmup-history-run-timeline';
import { WarmupHistoryBatch } from './warmup-history-batch';
import { Button } from './ui/button';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
import type { WarmupHistoryRun } from '@/lib/warmup-history-run';
export function WalletWarmupHistoryRuns({ plan }: { plan: SavedWarmup }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Warmup history run controls">
      <Button variant="outline" onClick={() => setOpen((value) => !value)}>
        {open ? 'Close history runs' : 'Open history runs'}
      </Button>
      {open && <HistoryRuns key={plan.id} plan={plan} />}
    </section>
  );
}
function HistoryRuns({ plan }: { plan: SavedWarmup }) {
  const [runs, setRuns] = useState<WarmupHistoryRun[]>([]),
    [error, setError] = useState(''),
    [readError, setReadError] = useState(''),
    [readAt, setReadAt] = useState(0),
    [reading, setReading] = useState(true),
    [stepping, setStepping] = useState(false),
    [controlling, setControlling] = useState(false);
  const [batchRunId, setBatchRunId] = useState<string | null>(null);
  const batchActive = useCallback((id: string, active: boolean) => {
    setBatchRunId((previous) =>
      active ? id : previous === id ? null : previous,
    );
  }, []);
  const batchRun = useCallback((next: WarmupHistoryRun) => {
    setRuns((previous) =>
      previous.map((row) =>
        row.id === next.id && next.revision >= row.revision ? next : row,
      ),
    );
    setReadAt(Date.now());
  }, []);
  const reader = useRef<AbortController | null>(null),
    step = useRef<AbortController | null>(null),
    control = useRef<AbortController | null>(null);
  const feed = useRef<ReturnType<typeof createRetainedRunStatusFeed> | null>(
    null,
  );
  const mutationPending = useRef(0);
  const [feedState, setFeedState] = useState<RetainedRunFeedState>({
    status: 'off',
    reason: '',
    reads: 0,
    retryInMs: null,
  });
  const reload = useCallback(
    async (feedSignal?: AbortSignal): Promise<boolean> => {
      reader.current?.abort();
      const c = new AbortController();
      reader.current = c;
      const signal = AbortSignal.any([
        c.signal,
        ...(feedSignal ? [feedSignal] : []),
        AbortSignal.timeout(10000),
      ]);
      setReading(true);
      try {
        const response = await fetch(
          `/api/wallet-workspace/warmup/runs?planId=${encodeURIComponent(plan.id)}`,
          { cache: 'no-store', signal },
        );
        const data = (await response.json()) as {
          planId: string;
          runs: WarmupHistoryRun[];
          executionAllowed: boolean;
          error?: string;
        };
        if (
          !response.ok ||
          data.planId !== plan.id ||
          data.executionAllowed !== false ||
          !Array.isArray(data.runs) ||
          data.runs.length > 20 ||
          data.runs.some(
            (r) =>
              r.planId !== plan.id ||
              !Number.isSafeInteger(r.revision) ||
              r.revision < 1,
          ) ||
          new Set(data.runs.map((r) => r.id)).size !== data.runs.length
        )
          throw new Error(data.error || 'History runs unavailable.');
        if (!signal.aborted && reader.current === c) {
          setRuns((previous) =>
            data.runs.map((incoming) => {
              const retained = previous.find((run) => run.id === incoming.id);
              return retained && retained.revision > incoming.revision
                ? retained
                : incoming;
            }),
          );
          setReadAt(Date.now());
          setReadError('');
          return true;
        }
      } catch (e) {
        if (!c.signal.aborted && !feedSignal?.aborted && reader.current === c)
          setReadError(
            signal.aborted
              ? 'Saved status request timed out. Retained results remain visible.'
              : e instanceof Error
                ? e.message
                : 'History runs unavailable.',
          );
      } finally {
        if (reader.current === c) setReading(false);
      }
      return false;
    },
    [plan.id],
  );
  useEffect(() => {
    let current = true;
    void Promise.resolve().then(() => {
      if (current) return reload();
    });
    return () => {
      current = false;
      reader.current?.abort();
      reader.current = null;
      step.current?.abort();
      control.current?.abort();
    };
  }, [reload]);
  useEffect(() => {
    const controller = createRetainedRunStatusFeed({
      unavailable: () =>
        mutationPending.current
          ? 'Run update in progress.'
          : document.hidden
            ? 'Tab hidden. Resumes when visible.'
            : !navigator.onLine
              ? 'Browser offline. Resumes when connected.'
              : null,
      read: reload,
      onState: setFeedState,
    });
    feed.current = controller;
    const availability = () => controller.availabilityChanged();
    document.addEventListener('visibilitychange', availability);
    window.addEventListener('online', availability);
    window.addEventListener('offline', availability);
    return () => {
      controller.destroy();
      document.removeEventListener('visibilitychange', availability);
      window.removeEventListener('online', availability);
      window.removeEventListener('offline', availability);
      if (feed.current === controller) feed.current = null;
    };
  }, [reload]);
  async function manualReload() {
    mutationPending.current++;
    feed.current?.pause('Manual status refresh in progress.');
    await reload();
    mutationPending.current--;
    feed.current?.availabilityChanged();
  }
  async function mutate(action: string, run?: WarmupHistoryRun) {
    mutationPending.current++;
    feed.current?.pause('Run update in progress.');
    const isStep = action === 'advance';
    const c = new AbortController();
    if (isStep) {
      step.current = c;
      setStepping(true);
    } else {
      control.current?.abort();
      control.current = c;
      setControlling(true);
    }
    setError('');
    try {
      const response = await fetch('/api/wallet-workspace/warmup/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: c.signal,
        body: JSON.stringify({
          action,
          id: run?.id ?? plan.id,
          revision: run?.revision ?? plan.revision,
        }),
      });
      const data = (await response.json()) as {
        run: WarmupHistoryRun;
        executionAllowed: boolean;
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.error || 'Run update unavailable.');
      if (
        !data.run ||
        data.run.planId !== plan.id ||
        data.executionAllowed !== false
      )
        throw new Error('Run does not match this plan.');
      if (!c.signal.aborted) await reload();
    } catch (e) {
      if (!c.signal.aborted) {
        setError(e instanceof Error ? e.message : 'Run update unavailable.');
        await reload();
      }
    } finally {
      if (!c.signal.aborted) {
        if (isStep) setStepping(false);
        else setControlling(false);
      }
      mutationPending.current--;
      feed.current?.availabilityChanged();
    }
  }
  const active = runs.some((r) =>
    ['planned', 'running', 'paused'].includes(r.state),
  );
  return (
    <section aria-label="Warmup history runs">
      <h5>History review runs</h5>
      <p>
        Persistent public history checks for this plan. Each “Check next wallet”
        reads one address. Nothing runs in the background and no trades are
        scheduled. Reload recovers saved results; a lost read can be retried
        after its 45-second lease expires.
      </p>
      <div className="wallet-roster-actions">
        <Button
          variant="outline"
          disabled={
            reading || controlling || stepping || feedState.status !== 'off'
          }
          onClick={() => feed.current?.start()}
        >
          Start live run status
        </Button>
        <Button
          variant="outline"
          disabled={feedState.status === 'off'}
          onClick={() => feed.current?.stop()}
        >
          Stop live run status
        </Button>
      </div>
      <p>
        Live status reads saved results every five seconds while this panel is
        visible and online. It resumes after reconnecting and retries failed
        reads with up to 30 seconds between attempts. It does not check wallets
        or advance runs. Closing the panel stops it.
      </p>
      <output aria-live="polite">
        Live status: {feedState.status} · {feedState.reads} successful
        refreshes.
        {feedState.reason && ` ${feedState.reason}`}
        {feedState.retryInMs !== null &&
          ` Retry in ${feedState.retryInMs / 1000} seconds.`}
      </output>
      {readAt > 0 && (
        <p>Saved status read: {new Date(readAt).toLocaleString()}</p>
      )}
      <Button
        variant="outline"
        disabled={plan.archived || active || controlling || stepping || reading}
        onClick={() => void mutate('create')}
      >
        Create history run
      </Button>
      <Button
        variant="outline"
        disabled={reading}
        onClick={() => void manualReload()}
      >
        {reading ? 'Reloading runs…' : 'Reload history runs'}
      </Button>
      {stepping && (
        <output>
          Reading a public wallet. Reload runs to see its current revision and
          pause or cancel it while the read is in flight.
        </output>
      )}
      {error && <p role="alert">{error}</p>}
      {readError && <p role="alert">{readError}</p>}
      {runs.map((run) => (
        <article key={run.id}>
          <strong>
            {run.state} · {run.document.results.length}/
            {run.document.wallets.length} checked
          </strong>
          <p>
            Plan revision {run.planRevision} · run revision {run.revision} ·{' '}
            {new Date(run.updatedAt).toLocaleString()}
          </p>
          {run.planRevision !== plan.revision && (
            <p>
              This run captures an older plan revision. Its results remain
              available; further checks require the captured plan and wallets to
              stay current.
            </p>
          )}
          {run.leaseUntil !== null && (
            <p>
              Wallet read lease ends{' '}
              {new Date(run.leaseUntil).toLocaleTimeString()}. Reload after that
              time to retry an interrupted read.
            </p>
          )}
          {['planned', 'running'].includes(run.state) && (
            <>
              <WarmupHistoryBatch
                run={run}
                plan={plan}
                onRun={batchRun}
                onActive={batchActive}
                disabled={
                  stepping ||
                  controlling ||
                  (batchRunId !== null && batchRunId !== run.id)
                }
              />
              <Button
                variant="outline"
                disabled={
                  stepping ||
                  batchRunId !== null ||
                  controlling ||
                  plan.archived ||
                  (run.leaseUntil !== null && run.leaseUntil > readAt) ||
                  run.planRevision !== plan.revision
                }
                onClick={() => void mutate('advance', run)}
              >
                Check next wallet
              </Button>
              <Button
                variant="outline"
                disabled={controlling}
                onClick={() => void mutate('pause', run)}
              >
                Pause history run
              </Button>
            </>
          )}
          {run.state === 'paused' && (
            <Button
              variant="outline"
              disabled={
                controlling ||
                plan.archived ||
                run.planRevision !== plan.revision
              }
              onClick={() => void mutate('resume', run)}
            >
              Resume history run
            </Button>
          )}
          {['planned', 'running', 'paused'].includes(run.state) && (
            <Button
              variant="outline"
              disabled={controlling}
              onClick={() => void mutate('cancel', run)}
            >
              Cancel history run
            </Button>
          )}
          {run.state === 'completed' && (
            <p>
              All requested checks finished. Failures and interruptions remain
              listed and completion does not establish wallet readiness.
            </p>
          )}
          <WarmupHistoryRunTimeline id={run.id} revision={run.revision} />
          {run.document.results.map((result) => (
            <div key={result.address}>
              <p className="warmup-address">{result.address}</p>
              {result.error ? (
                <p>{result.error}</p>
              ) : (
                result.observation && (
                  <>
                    <p>
                      Balance: {result.observation.nativeBalance}{' '}
                      {result.observation.currency} ·{' '}
                      {result.observation.sampleCount === null
                        ? `Outgoing nonce: ${result.observation.outgoingTransactions}`
                        : `Sampled signatures: ${result.observation.sampleCount}`}
                    </p>
                    <p>
                      {result.observation.source} ·{' '}
                      {new Date(result.observation.observedAt).toLocaleString()}{' '}
                      · block/slot {result.observation.block}
                    </p>
                    <small>{result.observation.coverage}</small>
                  </>
                )
              )}
            </div>
          ))}
        </article>
      ))}
      {runs.length === 0 && !reading && (
        <p>No saved history runs. The latest 20 runs appear here.</p>
      )}
    </section>
  );
}
