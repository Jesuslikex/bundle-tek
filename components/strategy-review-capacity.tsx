'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SavedStrategyDraft } from '@/lib/strategy-session-drafts';
import { strategyDraftRequest } from '@/lib/strategy-draft-client';
import {
  readStrategyCapacityView,
  type StrategyCapacityView,
} from '@/lib/strategy-capacity-client';
import {
  strategyReviewCandidate,
  reviewInputFits,
  type ReviewCapacityEvent,
} from '@/lib/strategy-review-capacity';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { Button } from '@/components/ui/button';
import styles from './strategy-session-planner.module.css';
const endpoint = '/api/imported-projects/strategy-capacity';
export function StrategyReviewCapacity({
  draft,
  disabled,
  contextKey,
}: {
  draft: SavedStrategyDraft;
  disabled: boolean;
  contextKey: string;
}) {
  const [open, setOpen] = useState(false),
    [view, setView] = useState<StrategyCapacityView | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(draft.plan.input.strategies[0].id),
    [candidate, setCandidate] = useState('0');
  const pending = useRef<AbortController | null>(null),
    retry = useRef<{ key: string; id: string } | null>(null);
  const [context, setContext] = useState(contextKey);
  if (context !== contextKey) {
    setContext(contextKey);
    setView(null);
    setNotice(
      'Context changed. Reload review slots; retained capacity is never released automatically.',
    );
  }
  useEffect(() => () => pending.current?.abort(), []);
  useLayoutEffect(() => {
    pending.current?.abort();
  }, [contextKey]);
  const row = draft.plan.input.strategies.find((r) => r.id === selected)!;
  const units = (raw: string | null) =>
    raw === null
      ? 'No amount cap'
      : `${formatNativeBalance(raw, draft.plan.summary.inputDecimals)} ${draft.plan.summary.inputUnit}`;
  async function request(event?: ReviewCapacityEvent) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const raw = await strategyDraftRequest(
        event
          ? endpoint
          : `${endpoint}?projectId=${draft.plan.input.projectId}&draftId=${draft.id}`,
        event
          ? {
              projectId: draft.plan.input.projectId,
              draftId: draft.id,
              revision: view!.revision,
              event,
            }
          : undefined,
        controller.signal,
        'capacity',
      );
      const data = await readStrategyCapacityView(raw, draft);
      if (event) {
        const hold = data.state.holds.find((h) => h.id === event.id);
        if (
          !hold ||
          (event.kind === 'release'
            ? hold.state !== 'released'
            : hold.strategyId !== event.strategyId ||
              hold.candidate !== event.candidate)
        )
          throw Error('Review slot response differs. Reload review slots.');
      }
      if (controller.signal.aborted || pending.current !== controller) return;
      setView(data);
      if (event)
        setNotice(
          event.kind === 'release'
            ? 'Review slot released. No wallet funds moved.'
            : data.state.holds.find((h) => h.id === event.id)?.state ===
                'released'
              ? 'This request was already released. It did not claim capacity again.'
              : 'Review slot saved. This claims draft input capacity only; no wallet funds are reserved and no trades are scheduled.',
        );
    } catch (e) {
      if (pending.current === controller) {
        const message =
          e instanceof Error ? e.message : 'Review slots unavailable.';
        setError(
          event
            ? `${message} Reload review slots to recover the current state.`
            : message,
        );
        if (event) setView(null);
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  const active = view?.state.holds.filter((h) => h.state === 'held') ?? [],
    released = view?.state.holds.filter((h) => h.state === 'released') ?? [];
  let selectionError = '';
  try {
    const terms = strategyReviewCandidate(
        draft.plan,
        selected,
        Number(candidate),
      ),
      strategyRemaining = view?.summary.strategies.find(
        (s) => s.id === selected,
      )?.remainingRaw;
    if (
      active.some(
        (h) => h.strategyId === selected && h.candidate === Number(candidate),
      )
    )
      selectionError = 'This candidate already has a review slot.';
    else if (
      view &&
      (!reviewInputFits(terms.unitsRaw, view.summary.remainingRaw) ||
        !reviewInputFits(terms.unitsRaw, strategyRemaining))
    )
      selectionError = `This candidate needs ${units(terms.unitsRaw)} of unclaimed input capacity. Release an unused review slot first.`;
  } catch {
    selectionError = 'This candidate falls outside the reviewed time limits.';
  }
  return (
    <section aria-label={`Review capacity for ${draft.plan.input.name}`}>
      <Button
        type="button"
        variant="outline"
        aria-expanded={open}
        onClick={() => {
          if (open) pending.current?.abort();
          setOpen(!open);
          if (!open) void request();
        }}
      >
        {open ? 'Close review slots' : 'Review shared budget'}
      </Button>
      {open && (
        <div className={styles.workspace}>
          <p>
            Review slots share this saved draft’s input caps across strategies.
            They can be held before the scheduled start, but they never reserve
            wallet funds or prove a Limit trigger. Fees, current prices, wallet
            ownership proof, signing and execution need separate checks. No
            trade is scheduled.
          </p>
          <div className={styles.actions}>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void request()}
            >
              Reload review slots
            </Button>
            {busy && (
              <Button
                type="button"
                variant="outline"
                onClick={() => pending.current?.abort()}
              >
                Cancel slot request
              </Button>
            )}
          </div>
          {error && <p role="alert">{error}</p>}
          {notice && <output>{notice}</output>}
          {view && (
            <>
              <p>
                Claimed input capacity: {units(view.summary.heldRaw)}. Unclaimed
                shared cap: {units(view.summary.remainingRaw)}.
              </p>
              <ul>
                {view.summary.strategies.map((s, i) => (
                  <li key={s.id}>
                    Strategy {i + 1}: {units(s.heldRaw)} claimed;{' '}
                    {s.remainingRaw === null
                      ? 'no separate amount cap'
                      : `${units(s.remainingRaw)} unclaimed`}
                    .
                  </li>
                ))}
              </ul>
              {disabled || draft.archived ? (
                <p>
                  New slots are unavailable in this context. You can still
                  release unused review slots below.
                </p>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const key = `${selected}:${candidate}`;
                    const prior = retry.current;
                    if (
                      !prior ||
                      prior.key !== key ||
                      view.state.holds.some(
                        (h) => h.id === prior.id && h.state === 'released',
                      )
                    )
                      retry.current = { key, id: crypto.randomUUID() };
                    void request({
                      kind: 'hold',
                      id: retry.current!.id,
                      strategyId: selected,
                      candidate: Number(candidate),
                    });
                  }}
                >
                  <label>
                    Strategy
                    <select
                      aria-label="Review slot strategy"
                      value={selected}
                      disabled={busy}
                      onChange={(e) => {
                        setSelected(e.target.value);
                        setCandidate('0');
                      }}
                    >
                      {draft.plan.input.strategies.map((s, i) => (
                        <option key={s.id} value={s.id}>
                          Strategy {i + 1}: {s.kind}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Candidate
                    <select
                      aria-label="Review slot candidate"
                      value={candidate}
                      disabled={busy}
                      onChange={(e) => setCandidate(e.target.value)}
                    >
                      {Array.from(
                        { length: row.kind === 'DCA' ? row.cycles : 1 },
                        (_, i) => {
                          let timing: string;
                          try {
                            timing = strategyReviewCandidate(
                              draft.plan,
                              row.id,
                              i,
                            ).notBefore;
                          } catch {
                            timing = 'Outside reviewed time limit';
                          }
                          return (
                            <option
                              key={i}
                              value={i}
                              disabled={
                                timing === 'Outside reviewed time limit'
                              }
                            >
                              {row.kind === 'DCA'
                                ? `Cycle ${i + 1}`
                                : 'Limit candidate'}{' '}
                              · {timing}
                            </option>
                          );
                        },
                      )}
                    </select>
                  </label>
                  <Button
                    type="submit"
                    disabled={busy || Boolean(selectionError)}
                  >
                    Reserve for review
                  </Button>
                  {selectionError && <p>{selectionError}</p>}
                </form>
              )}
              {!active.length && <p>No active review slots.</p>}
              <ul>
                {active.map((h) => {
                  const terms = strategyReviewCandidate(
                      draft.plan,
                      h.strategyId,
                      h.candidate,
                    ),
                    index = draft.plan.input.strategies.findIndex(
                      (s) => s.id === h.strategyId,
                    );
                  return (
                    <li key={h.id}>
                      Strategy {index + 1}, candidate {h.candidate + 1}:{' '}
                      {units(h.unitsRaw)}. Earliest trade time {terms.notBefore}
                      {terms.endsAt
                        ? `; reviewed window ends ${terms.endsAt}`
                        : ''}
                      .
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void request({ kind: 'release', id: h.id })
                        }
                      >
                        Release review slot {index + 1}.{h.candidate + 1}
                      </Button>
                    </li>
                  );
                })}
              </ul>
              <details>
                <summary>Released review slots ({released.length})</summary>
                <p>
                  Released request IDs remain in history and cannot claim
                  capacity again.
                </p>
                <ul>
                  {released
                    .slice(-20)
                    .reverse()
                    .map((h) => (
                      <li key={h.id}>
                        {h.id}: {units(h.unitsRaw)}, released {h.releasedAt}
                      </li>
                    ))}
                </ul>
                {released.length > 20 && (
                  <p>
                    Showing the latest 20 released slots. Earlier records remain
                    retained.
                  </p>
                )}
              </details>
            </>
          )}
        </div>
      )}
    </section>
  );
}
