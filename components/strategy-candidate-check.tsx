'use client';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { SavedStrategyDraft } from '@/lib/strategy-session-drafts';
import type { StrategyCapacityView } from '@/lib/strategy-capacity-client';
import {
  requireStrategyCandidateCheck,
  type StrategyCandidateCheck,
} from '@/lib/strategy-candidate-check';
import { strategyDraftRequest } from '@/lib/strategy-draft-client';
import { Button } from '@/components/ui/button';
import { StrategyUnsignedPreviewPanel } from './strategy-unsigned-preview';

export function StrategyCandidateCheckPanel({
  draft,
  capacity,
  holdId,
  blocked,
}: {
  draft: SavedStrategyDraft;
  capacity: StrategyCapacityView;
  holdId: string;
  blocked: boolean;
}) {
  const [snapshot, setSnapshot] = useState<{
      value: StrategyCandidateCheck;
      until: number;
    } | null>(null),
    [pair, setPair] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [clock, setClock] = useState(() => performance.now());
  const pending = useRef<AbortController | null>(null),
    selectId = useId();
  const contextKey = JSON.stringify({
    draft: draft.id,
    draftRevision: draft.revision,
    capacityRevision: capacity.revision,
    plan: capacity.planSha256,
    holdId,
    blocked,
  });
  const [context, setContext] = useState(contextKey);
  if (context !== contextKey) {
    setContext(contextKey);
    setSnapshot(null);
    setPair('');
    setError('');
  }
  useLayoutEffect(() => {
    pending.current?.abort();
  }, [contextKey]);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (!snapshot) return;
    const timer = setTimeout(
      () => setClock(performance.now()),
      Math.max(0, snapshot.until - performance.now()),
    );
    return () => clearTimeout(timer);
  }, [snapshot]);
  useEffect(() => {
    const invalidate = () => {
      pending.current?.abort();
      setSnapshot(null);
      setPair('');
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') invalidate();
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('offline', invalidate);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('offline', invalidate);
    };
  }, []);
  async function check() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const started = performance.now();
    setBusy(true);
    setError('');
    setSnapshot(null);
    try {
      const raw = await strategyDraftRequest(
        '/api/imported-projects/strategy-checks',
        {
          projectId: draft.plan.input.projectId,
          draftId: draft.id,
          revision: capacity.revision,
          holdId,
        },
        controller.signal,
        'checks',
      );
      const value = requireStrategyCandidateCheck(raw, draft, capacity, holdId);
      if (controller.signal.aborted || pending.current !== controller) return;
      const until =
          started + Date.parse(value.expiresAt) - Date.parse(value.checkedAt),
        now = performance.now();
      setClock(now);
      setSnapshot({ value, until });
      setPair((old) =>
        value.pools.some((p) => p.address === old) && now < until ? old : '',
      );
    } catch (e) {
      if (pending.current === controller)
        setError(
          e instanceof Error ? e.message : 'Condition check unavailable.',
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  const value = snapshot?.value,
    expired = snapshot !== null && clock >= snapshot.until,
    selected = value?.pools.find((p) => p.address === pair);
  return (
    <section aria-label="Candidate condition check">
      <Button
        type="button"
        variant="outline"
        disabled={busy || blocked}
        onClick={() => void check()}
      >
        Check current conditions
      </Button>
      {busy && (
        <>
          <output>Checking public timing and market data.</output>
          <Button
            type="button"
            variant="outline"
            onClick={() => pending.current?.abort()}
          >
            Cancel condition check
          </Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {value && (
        <div>
          {expired ? (
            <output>
              This check expired. Check current conditions again before using
              its result.
            </output>
          ) : value.status === 'scheduled' ? (
            <p>
              The scheduled start has not arrived. No market provider was read.
            </p>
          ) : value.status === 'ended' ? (
            <p>
              The reviewed time window has ended. Release this unused slot or
              save a new draft with reviewed timing.
            </p>
          ) : value.status === 'dca-due' ? (
            <p>
              This DCA cycle is due by the server clock. Preview it to check
              current balances, a quote and simulation.
            </p>
          ) : (
            <>
              <p>
                Choose a pool to inspect its current Limit condition. No pool is
                selected automatically.
              </p>
              {value.pools.length ? (
                <label htmlFor={selectId}>
                  Pool
                  <select
                    id={selectId}
                    value={pair}
                    onChange={(e) => setPair(e.target.value)}
                  >
                    <option value="">Choose a pool</option>
                    {value.pools.map((p) => (
                      <option key={p.address} value={p.address}>
                        {p.dex} · {p.quoteSymbol} · {p.address}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <p>
                  No base-token pools were returned. Quote-only appearances are
                  not used for this condition.
                </p>
              )}
              {selected && (
                <output>
                  {selected.condition === 'unavailable'
                    ? 'Market cap is unavailable for this pool.'
                    : `Reported market cap: $${selected.marketCapUsd}. The saved threshold is ${selected.condition === 'met' ? 'currently met' : 'not met'} in this pool.`}
                </output>
              )}
            </>
          )}
          <p>
            This is a temporary read-only check. It does not approve a trade or
            change review capacity.
          </p>
          {!blocked &&
            !expired &&
            (value.status === 'dca-due' || selected?.condition === 'met') && (
              <StrategyUnsignedPreviewPanel
                key={JSON.stringify([contextKey, value.checkedAt, pair])}
                draft={draft}
                capacity={capacity}
                holdId={holdId}
                conditionPool={value.kind === 'Limit' ? pair : null}
              />
            )}
          <details>
            <summary>Check details</summary>
            <p>
              Server check: {value.checkedAt}. Expires: {value.expiresAt}.
            </p>
            <p>
              Scheduled start: {value.notBefore}. Deadline:{' '}
              {value.endsAt ?? 'No time cap'}.
            </p>
            {value.market && (
              <p>
                Source: {value.market.source}; received{' '}
                {value.market.observedAt}. Returned{' '}
                {value.market.returnedPairCount} pairs, including{' '}
                {value.market.quoteOnlyPairCount} quote-only appearances; at
                most 20 base-token pools shown. This is sampled provider data,
                not chain finality or complete market coverage.
              </p>
            )}
            {selected && <p>Selected pool: {selected.address}.</p>}
          </details>
        </div>
      )}
    </section>
  );
}
