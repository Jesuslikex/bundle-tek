'use client';
import { useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import {
  planStrategySession,
  type StrategySessionInput,
  type StrategySessionPlan,
  type DraftStrategy,
} from '@/lib/strategy-session-plan';
import type { SavedStrategyDraft } from '@/lib/strategy-session-drafts';
import {
  readSavedStrategyDraft,
  strategyDraftRequest,
} from '@/lib/strategy-draft-client';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import {
  parseDurationParts,
  splitDurationSeconds,
  type DurationParts,
} from '@/lib/duration-parts';
import { DurationInput } from './duration-input';
import { Button } from './ui/button';
import { Input } from './ui/input';
import styles from './strategy-session-planner.module.css';
import { StrategyReviewCapacity } from './strategy-review-capacity';

type EditorRow = {
  id: string;
  kind: 'DCA' | 'Limit';
  wallet: string;
  walletRevision: number;
  maximum: string;
  duration: DurationParts;
  amount: string;
  cycles: string;
  interval: DurationParts;
  threshold: string;
  direction: 'at-or-above' | 'at-or-below';
};
const emptyDuration = (): DurationParts => ({
  hours: '',
  minutes: '',
  seconds: '',
});
const newRow = (): EditorRow => ({
  id: crypto.randomUUID(),
  kind: 'DCA',
  wallet: '',
  walletRevision: 0,
  maximum: '',
  duration: emptyDuration(),
  amount: '',
  cycles: '5',
  interval: splitDurationSeconds(60),
  threshold: '',
  direction: 'at-or-above',
});
const localDate = (utc: string) => {
  const date = new Date(utc);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, -1);
};
const endpoint = '/api/imported-projects/strategy-drafts';
export function StrategySessionPlanner(props: {
  project: ImportedTokenProject;
  wallets: WorkspaceWallet[];
  locked: boolean;
}) {
  if (props.project.document.token.chain !== 'Solana') return null;
  return (
    <StrategyDraftWorkspace
      key={`${props.project.id}:${props.project.revision}:${props.project.archived}`}
      {...props}
    />
  );
}
function StrategyDraftWorkspace({
  project,
  wallets,
  locked,
}: {
  project: ImportedTokenProject;
  wallets: WorkspaceWallet[];
  locked: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false),
    [name, setName] = useState('Strategy session'),
    [side, setSide] = useState<'Buy' | 'Sell'>('Buy'),
    [maximum, setMaximum] = useState(''),
    [duration, setDuration] = useState(emptyDuration),
    [start, setStart] = useState(''),
    [retainedStart, setRetainedStart] = useState<{
      local: string;
      utc: string;
    } | null>(null),
    [rows, setRows] = useState<EditorRow[]>(() => [newRow()]);
  const [review, setReview] = useState<{
      key: string;
      plan: StrategySessionPlan;
    } | null>(null),
    [drafts, setDrafts] = useState<SavedStrategyDraft[]>([]),
    [archived, setArchived] = useState(false),
    [next, setNext] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const pending = useRef<AbortController | null>(null),
    retry = useRef<{ key: string; id: string } | null>(null);
  const eligible = wallets.filter(
    (w) =>
      w.chain === 'Solana' &&
      !w.archived &&
      Number.isSafeInteger(w.revision) &&
      w.revision > 0,
  );
  const eligibleRevisions = new Map(
    eligible.map((w) => [w.address, w.revision]),
  );
  const contextKey = JSON.stringify({
    project: project.id,
    revision: project.revision,
    token: project.document.token,
    archived: project.archived,
    locked,
    wallets: rows.map((row) => ({
      address: row.wallet,
      current: eligible.find((w) => w.address === row.wallet)?.revision ?? null,
    })),
  });
  const [observedContext, setObservedContext] = useState(contextKey);
  if (observedContext !== contextKey) {
    setObservedContext(contextKey);
    setReview(null);
  }
  const formKey = JSON.stringify({
    contextKey,
    name,
    side,
    maximum,
    duration,
    start,
    retainedStart,
    rows,
  });
  const currentReview = review?.key === formKey ? review.plan : null;
  useEffect(() => () => pending.current?.abort(), []);
  useLayoutEffect(() => {
    pending.current?.abort();
  }, [contextKey]);
  async function run(
    work: (signal: AbortSignal, current: () => boolean) => Promise<void>,
  ) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    setNotice('');
    const current = () =>
      !controller.signal.aborted && pending.current === controller;
    try {
      await work(controller.signal, current);
    } catch (e) {
      if (pending.current === controller)
        setError(
          e instanceof Error ? e.message : 'Strategy drafts unavailable.',
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  async function load(before?: string, view = archived) {
    await run(async (signal, current) => {
      const data = await strategyDraftRequest(
        `${endpoint}?projectId=${project.id}&archived=${Number(view)}${before ? `&before=${encodeURIComponent(before)}` : ''}`,
        undefined,
        signal,
      );
      if (
        data.projectId !== project.id ||
        data.archived !== view ||
        !Array.isArray(data.drafts) ||
        data.drafts.length > 20 ||
        (data.next !== null && typeof data.next !== 'string')
      )
        throw Error('Strategy draft page differs.');
      const page = data.drafts.map((d) =>
        readSavedStrategyDraft(d, project.id),
      );
      if (
        new Set(page.map((d) => d.id)).size !== page.length ||
        page.some((d) => d.archived !== view) ||
        (data.next !== null && data.next !== page.at(-1)?.id)
      )
        throw Error('Strategy draft page differs.');
      if (!current()) return;
      if (before && page.some((d) => drafts.some((old) => old.id === d.id)))
        throw Error('Draft pages overlap. Reload the list.');
      setDrafts(before ? [...drafts, ...page] : page);
      setNext(data.next as string | null);
    });
  }
  const seconds = (parts: DurationParts, label: string) => {
    const parsed = parseDurationParts(parts, 2678400).seconds;
    if (parsed === null || parsed < 1)
      throw Error(`Choose a positive ${label}.`);
    return parsed;
  };
  const optionalSeconds = (parts: DurationParts, label: string) =>
    Object.values(parts).every((v) => v === '') ? null : seconds(parts, label);
  function build(): StrategySessionPlan {
    const utc =
      retainedStart?.local === start
        ? retainedStart.utc
        : new Date(start).toISOString();
    const input: StrategySessionInput = {
      name,
      projectId: project.id,
      projectRevision: project.revision,
      side,
      startAt: utc,
      maxAmount: maximum === '' ? null : maximum,
      durationSeconds: optionalSeconds(duration, 'session duration'),
      strategies: rows.map((row) => {
        if (row.kind === 'DCA' && !/^[1-9]\d?$/.test(row.cycles))
          throw Error('Choose 2 to 25 whole DCA cycles.');
        const base = {
          id: row.id,
          wallet: row.wallet,
          walletRevision: row.walletRevision,
          maxAmount: row.maximum === '' ? null : row.maximum,
          durationSeconds: optionalSeconds(row.duration, 'strategy duration'),
        };
        return row.kind === 'DCA'
          ? {
              ...base,
              kind: 'DCA',
              amountPerCycle: row.amount,
              cycles: Number(row.cycles),
              intervalSeconds: seconds(row.interval, 'DCA interval'),
            }
          : {
              ...base,
              kind: 'Limit',
              amount: row.amount,
              marketCapUsd: row.threshold,
              direction: row.direction,
            };
      }),
    };
    return planStrategySession(input, {
      projectId: project.id,
      projectRevision: project.revision,
      token: project.document.token,
      wallets,
    });
  }
  function editRow(index: number, patch: Partial<EditorRow>) {
    setRows((old) =>
      old.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  }
  function openDraft(draft: SavedStrategyDraft) {
    retry.current = null;
    const input = draft.plan.input;
    setName(input.name);
    setSide(input.side);
    setMaximum(input.maxAmount ?? '');
    setDuration(
      input.durationSeconds === null
        ? emptyDuration()
        : splitDurationSeconds(input.durationSeconds),
    );
    const local = localDate(input.startAt);
    setStart(local);
    setRetainedStart({ local, utc: input.startAt });
    setRows(
      input.strategies.map((row: DraftStrategy) => ({
        ...newRow(),
        id: row.id,
        kind: row.kind,
        wallet: row.wallet,
        walletRevision: row.walletRevision,
        maximum: row.maxAmount ?? '',
        duration:
          row.durationSeconds === null
            ? emptyDuration()
            : splitDurationSeconds(row.durationSeconds),
        amount: row.kind === 'DCA' ? row.amountPerCycle : row.amount,
        ...(row.kind === 'DCA'
          ? {
              cycles: String(row.cycles),
              interval: splitDurationSeconds(row.intervalSeconds),
            }
          : { threshold: row.marketCapUsd, direction: row.direction }),
      })),
    );
    setReview(null);
    setError('');
    setNotice(
      'Opened saved terms. Recheck current wallets and review before saving a new copy. The saved start has not moved.',
    );
  }
  const amountField = (
    label: string,
    value: string,
    change: (value: string) => void,
    fieldId: string,
    required = true,
  ) => (
    <label htmlFor={fieldId}>
      {label}
      <Input
        id={fieldId}
        value={value}
        inputMode="decimal"
        required={required}
        disabled={busy || locked || project.archived}
        onChange={(e) => change(e.target.value)}
      />
    </label>
  );
  return (
    <section aria-label="Multi-strategy drafts" className={styles.panel}>
      <Button
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (open) pending.current?.abort();
          else void load();
          setOpen((v) => !v);
        }}
      >
        {open ? 'Close' : 'Open'} strategy drafts
      </Button>
      {open && (
        <div className={styles.workspace}>
          <h4>Plan a strategy session</h4>
          <p>
            Combine DCA and Limit strategies with separate limits and one shared
            stop. Draft planning only. Saving schedules no trades and reserves
            no funds.
          </p>
          <form
            className={styles.workspace}
            onChange={() => {
              setReview(null);
              setNotice('');
            }}
            onInvalidCapture={(e) => {
              if (e.target instanceof HTMLInputElement) {
                const details = e.target.closest('details');
                if (details) {
                  details.open = true;
                  e.target.focus();
                }
              }
            }}
            onSubmit={(e) => {
              e.preventDefault();
              setError('');
              setNotice('');
              try {
                if (locked || project.archived)
                  throw Error('This project is locked or archived.');
                setReview({ key: formKey, plan: build() });
              } catch (caught) {
                setError(
                  caught instanceof Error
                    ? caught.message
                    : 'Review strategy settings.',
                );
              }
            }}
          >
            <div className={styles.grid}>
              <label htmlFor={`${id}-name`}>
                Draft name
                <Input
                  id={`${id}-name`}
                  value={name}
                  maxLength={80}
                  required
                  disabled={busy || locked || project.archived}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label htmlFor={`${id}-side`}>
                Session side
                <select
                  id={`${id}-side`}
                  value={side}
                  disabled={busy || locked || project.archived}
                  onChange={(e) => {
                    setSide(e.target.value as 'Buy' | 'Sell');
                    setMaximum('');
                    setRows((old) =>
                      old.map((row) => ({ ...row, amount: '', maximum: '' })),
                    );
                  }}
                >
                  <option>Buy</option>
                  <option>Sell</option>
                </select>
              </label>
            </div>
            <div className={styles.grid}>
              {amountField(
                `Shared maximum input (${side === 'Buy' ? 'SOL' : project.document.token.symbol})`,
                maximum,
                setMaximum,
                `${id}-max`,
                false,
              )}
              <DurationInput
                label="Session time limit"
                emptyLabel="No shared time cap"
                value={duration}
                onChange={setDuration}
                maximumSeconds={2678400}
                disabled={busy || locked || project.archived}
              />
            </div>
            <label htmlFor={`${id}-start`}>
              Session start (your timezone)
              <Input
                id={`${id}-start`}
                type="datetime-local"
                step="0.001"
                value={start}
                required
                disabled={busy || locked || project.archived}
                onChange={(e) => {
                  setStart(e.target.value);
                  setRetainedStart(null);
                }}
              />
            </label>
            <Button
              type="button"
              variant="outline"
              disabled={busy || locked || project.archived}
              onClick={() => {
                const utc = new Date(Date.now() + 30 * 60000).toISOString(),
                  local = localDate(utc);
                setStart(local);
                setRetainedStart({ local, utc });
                setReview(null);
                setNotice(
                  'Start captured for review. It will not move when you save or retry.',
                );
              }}
            >
              Start 30 minutes from now
            </Button>
            <p>
              Amount and time limits are optional. This draft covers finite DCA
              cycles and single Limit candidates; it does not run continuous
              strategies.
            </p>
            <p>
              Each strategy stops at its own limit. The whole session must stop
              when its shared amount or time limit is reached, whichever comes
              first.
            </p>
            {rows.map((row, index) => {
              const active = eligible.some(
                  (w) =>
                    w.address === row.wallet &&
                    w.revision === row.walletRevision,
                ),
                prefix = `${id}-${index}`,
                unit = side === 'Buy' ? 'SOL' : project.document.token.symbol;
              return (
                <fieldset
                  key={row.id}
                  className={styles.card}
                  disabled={busy || locked || project.archived}
                >
                  <legend>Strategy {index + 1}</legend>
                  <div className={styles.grid}>
                    <label htmlFor={`${prefix}-kind`}>
                      Strategy {index + 1} type
                      <select
                        id={`${prefix}-kind`}
                        value={row.kind}
                        onChange={(e) =>
                          editRow(index, {
                            kind: e.target.value as 'DCA' | 'Limit',
                          })
                        }
                      >
                        <option>DCA</option>
                        <option>Limit</option>
                      </select>
                    </label>
                    <label htmlFor={`${prefix}-wallet`}>
                      Strategy {index + 1} wallet
                      <select
                        id={`${prefix}-wallet`}
                        required
                        value={
                          active ? `${row.wallet}:${row.walletRevision}` : ''
                        }
                        onChange={(e) => {
                          const w = eligible.find(
                            (w) =>
                              `${w.address}:${w.revision}` === e.target.value,
                          );
                          editRow(index, {
                            wallet: w?.address ?? '',
                            walletRevision: w?.revision ?? 0,
                          });
                        }}
                      >
                        <option value="">Choose wallet</option>
                        {eligible.map((w) => (
                          <option
                            key={w.address}
                            value={`${w.address}:${w.revision}`}
                          >
                            {w.label ||
                              `${w.address.slice(0, 4)}…${w.address.slice(-4)}`}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {row.wallet && !active && (
                    <p className={styles.error}>
                      This wallet changed. Choose its current revision again.
                    </p>
                  )}
                  {amountField(
                    `${row.kind === 'DCA' ? 'Input per cycle' : 'Limit input'} (${unit})`,
                    row.amount,
                    (value) => editRow(index, { amount: value }),
                    `${prefix}-amount`,
                  )}
                  {row.kind === 'DCA' ? (
                    <div className={styles.grid}>
                      <label htmlFor={`${prefix}-cycles`}>
                        Strategy {index + 1} cycles
                        <Input
                          id={`${prefix}-cycles`}
                          inputMode="numeric"
                          value={row.cycles}
                          required
                          onChange={(e) =>
                            editRow(index, { cycles: e.target.value })
                          }
                        />
                      </label>
                      <DurationInput
                        label={`Strategy ${index + 1} interval`}
                        value={row.interval}
                        onChange={(value) =>
                          editRow(index, { interval: value })
                        }
                        maximumSeconds={86400}
                      />
                    </div>
                  ) : (
                    <div className={styles.grid}>
                      {amountField(
                        `Strategy ${index + 1} market cap (USD)`,
                        row.threshold,
                        (value) => editRow(index, { threshold: value }),
                        `${prefix}-threshold`,
                      )}
                      <label htmlFor={`${prefix}-direction`}>
                        Trigger direction
                        <select
                          id={`${prefix}-direction`}
                          value={row.direction}
                          onChange={(e) =>
                            editRow(index, {
                              direction: e.target
                                .value as EditorRow['direction'],
                            })
                          }
                        >
                          <option value="at-or-above">At or above</option>
                          <option value="at-or-below">At or below</option>
                        </select>
                      </label>
                    </div>
                  )}
                  <details>
                    <summary>Strategy {index + 1} limits</summary>
                    <div className={styles.grid}>
                      {amountField(
                        `Strategy ${index + 1} maximum input (${unit})`,
                        row.maximum,
                        (value) => editRow(index, { maximum: value }),
                        `${prefix}-max`,
                        false,
                      )}
                      <DurationInput
                        label={`Strategy ${index + 1} time limit`}
                        emptyLabel="No separate time cap"
                        value={row.duration}
                        onChange={(value) =>
                          editRow(index, { duration: value })
                        }
                        maximumSeconds={2678400}
                      />
                    </div>
                  </details>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={rows.length === 1}
                    onClick={() => {
                      setRows((old) => old.filter((_, i) => i !== index));
                      setReview(null);
                    }}
                  >
                    Remove strategy {index + 1}
                  </Button>
                </fieldset>
              );
            })}
            <div className={styles.actions}>
              <Button
                type="button"
                variant="outline"
                disabled={
                  rows.length >= 8 || busy || locked || project.archived
                }
                onClick={() => {
                  setRows((old) => [...old, newRow()]);
                  setReview(null);
                }}
              >
                Add strategy
              </Button>
              <Button
                type="submit"
                disabled={
                  busy || locked || project.archived || !eligible.length
                }
              >
                Review combined draft
              </Button>
            </div>
          </form>
          {(locked || project.archived) && (
            <output>
              New strategy drafts are unavailable while this project is locked
              or archived. Saved terms remain readable.
            </output>
          )}
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          {notice && <output>{notice}</output>}
          {currentReview && (
            <section
              aria-label="Combined strategy review"
              className={styles.card}
            >
              <h4>{currentReview.input.name}</h4>
              <p>
                {currentReview.input.side} ·{' '}
                {currentReview.input.strategies.length}{' '}
                {currentReview.input.strategies.length === 1
                  ? 'strategy'
                  : 'strategies'}{' '}
                · starts {currentReview.input.startAt}
              </p>
              <p>
                Whole-session maximum:{' '}
                {currentReview.summary.maximumInputRaw === null
                  ? 'No shared amount cap'
                  : formatNativeBalance(
                      currentReview.summary.maximumInputRaw,
                      currentReview.summary.inputDecimals,
                    )}{' '}
                {currentReview.summary.maximumInputRaw !== null &&
                  currentReview.summary.inputUnit}
                .{' '}
                {currentReview.summary.endsAt
                  ? `Stops by ${currentReview.summary.endsAt}.`
                  : 'No shared time cap.'}
              </p>
              {currentReview.summary.competingForBudget && (
                <p>
                  Candidate inputs exceed the shared budget. They compete for
                  that budget; not every candidate can use its full input. Draft
                  review does not allocate funds or determine trigger order.
                </p>
              )}
              <ul>
                {currentReview.summary.strategies.map((row, i) => {
                  const terms = currentReview.input.strategies[i];
                  return (
                    <li key={row.id}>
                      <strong>
                        Strategy {i + 1}: {terms.kind}
                      </strong>
                      <p>
                        Wallet: <span title={terms.wallet}>{terms.wallet}</span>
                      </p>
                      <p>
                        {terms.kind === 'DCA'
                          ? `${terms.amountPerCycle} ${currentReview.summary.inputUnit} per cycle; ${terms.cycles} cycles, every ${terms.intervalSeconds} seconds.`
                          : `${terms.amount} ${currentReview.summary.inputUnit} when market cap is ${terms.direction === 'at-or-above' ? 'at or above' : 'at or below'} ${terms.marketCapUsd} USD.`}
                      </p>
                      Separate maximum:{' '}
                      {row.maximumInputRaw === null
                        ? 'No separate amount cap'
                        : formatNativeBalance(
                            row.maximumInputRaw,
                            currentReview.summary.inputDecimals,
                          )}{' '}
                      {row.maximumInputRaw !== null &&
                        currentReview.summary.inputUnit}
                      ; up to {row.maximumTrades} candidate{' '}
                      {row.maximumTrades === 1 ? 'trade' : 'trades'} before its
                      limits. Separate time cap:{' '}
                      {terms.durationSeconds === null
                        ? 'None'
                        : `${terms.durationSeconds} seconds`}
                      . Effective end:{' '}
                      {row.effectiveEndsAt ??
                        'the end of its finite candidates (no time cap)'}
                      .
                    </li>
                  );
                })}
              </ul>
              <p>
                Limits use input amounts. Fees, rent, price impact and proceeds
                are separate. Limit triggers may never occur. Shared-budget
                admission, execution and settlement are not enabled.
              </p>
              <Button
                type="button"
                disabled={busy || locked || project.archived}
                onClick={() =>
                  void run(async (signal, current) => {
                    if (!retry.current || retry.current.key !== formKey)
                      retry.current = { key: formKey, id: crypto.randomUUID() };
                    const saveId = retry.current.id;
                    const data = await strategyDraftRequest(
                      endpoint,
                      {
                        action: 'save',
                        id: saveId,
                        input: currentReview.input,
                      },
                      signal,
                    );
                    const saved = readSavedStrategyDraft(
                      data.draft,
                      project.id,
                    );
                    if (
                      saved.id !== saveId ||
                      JSON.stringify(saved.plan) !==
                        JSON.stringify(currentReview)
                    )
                      throw Error(
                        'Saved draft response differs. Reload before retrying.',
                      );
                    if (!current()) return;
                    setDrafts((old) =>
                      archived || saved.archived
                        ? old
                        : [saved, ...old.filter((d) => d.id !== saved.id)],
                    );
                    setNotice(
                      saved.archived
                        ? 'This saved draft is archived. Open archived drafts to review or restore it.'
                        : 'Strategy draft saved. No trades scheduled and no funds reserved.',
                    );
                  })
                }
              >
                Save strategy draft
              </Button>
            </section>
          )}
          <section
            aria-label="Saved strategy drafts"
            className={styles.workspace}
          >
            <h4>Saved strategy drafts</h4>
            <div className={styles.actions}>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setDrafts([]);
                  setNext(null);
                  setArchived((v) => !v);
                  void load(undefined, !archived);
                }}
              >
                {archived ? 'Show active drafts' : 'Show archived drafts'}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void load()}
              >
                Reload strategy drafts
              </Button>
            </div>
            {!drafts.length && !busy && (
              <p>
                No {archived ? 'archived' : 'active'} strategy drafts on this
                page.
              </p>
            )}
            {drafts.map((draft) => (
              <article key={draft.id} className={styles.card}>
                <strong>{draft.plan.input.name}</strong>
                <p>
                  {draft.plan.input.side} · {draft.plan.input.strategies.length}{' '}
                  strategies · {new Date(draft.createdAt).toLocaleString()}
                </p>
                <div className={styles.actions}>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => openDraft(draft)}
                  >
                    Open {draft.plan.input.name}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run(async (signal, current) => {
                        const data = await strategyDraftRequest(
                          endpoint,
                          {
                            action: 'archive',
                            projectId: project.id,
                            id: draft.id,
                            revision: draft.revision,
                            archived: !draft.archived,
                          },
                          signal,
                        );
                        const saved = readSavedStrategyDraft(
                          data.draft,
                          project.id,
                        );
                        if (
                          saved.id !== draft.id ||
                          saved.revision !== draft.revision + 1 ||
                          saved.archived === draft.archived ||
                          JSON.stringify(saved.plan) !==
                            JSON.stringify(draft.plan)
                        )
                          throw Error('Draft state response differs. Reload.');
                        if (current()) {
                          setDrafts((old) =>
                            old.filter((d) => d.id !== draft.id),
                          );
                          setNotice(
                            saved.archived
                              ? 'Draft archived.'
                              : 'Draft restored.',
                          );
                        }
                      })
                    }
                  >
                    {draft.archived ? 'Restore' : 'Archive'}{' '}
                    {draft.plan.input.name}
                  </Button>
                </div>
                <StrategyReviewCapacity
                  draft={draft}
                  disabled={
                    locked ||
                    busy ||
                    project.archived ||
                    project.revision !== draft.plan.input.projectRevision ||
                    draft.plan.input.strategies.some(
                      (s) =>
                        eligibleRevisions.get(s.wallet) !== s.walletRevision,
                    )
                  }
                  contextKey={JSON.stringify({
                    project: project.id,
                    revision: project.revision,
                    archived: project.archived,
                    locked,
                    draftRevision: draft.revision,
                    wallets: draft.plan.input.strategies.map((s) => ({
                      address: s.wallet,
                      revision: eligibleRevisions.get(s.wallet) ?? null,
                    })),
                  })}
                />
              </article>
            ))}
            {next && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void load(next)}
              >
                Load more strategy drafts
              </Button>
            )}
          </section>
          {busy && (
            <div className={styles.actions}>
              <output>
                Reading or saving a public strategy draft. No transactions are
                started.
              </output>
              <Button
                type="button"
                variant="outline"
                onClick={() => pending.current?.abort()}
              >
                Cancel draft request
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
