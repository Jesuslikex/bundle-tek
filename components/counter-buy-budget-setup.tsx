'use client';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CounterPlan } from '@/lib/counter-trade-store';
import type { CounterPreviewWallet } from '@/lib/counter-preview-view';
import type {
  CounterBudgetReview,
  CounterBudgetSaved,
  CounterBudgetSelection,
} from '@/lib/counter-owned-budget';
import type {
  CounterBudgetPreview,
  CounterBudgetPreviewRequest,
} from '@/lib/counter-owned-preview';
import {
  admitCounterBudgetReview,
  admitCounterBudgetSaved,
  admitCounterBudgetPreview,
  parseCounterBudgetReminder,
  counterBudgetReminder,
  isCounterBudgetPrewriteRefusal,
  counterBudgetLamports,
  counterBudgetSol,
  COUNTER_BUY_BUDGET_REMINDER,
  COUNTER_BUY_METADATA_ACK,
} from '@/lib/counter-buy-budget-view';
import Link from 'next/link';
import { Button } from './ui/button';
import { Input } from './ui/input';
import styles from './counter-buy-budget-setup.module.css';

type Reminder = ReturnType<typeof counterBudgetReminder>;
type Props = {
  plan: CounterPlan;
  decisionIdentity: string;
  wallet: CounterPreviewWallet | null;
  maximumSolInputRaw: string | null;
  maximumFeeAndRentRaw: string | null;
  locked: boolean;
};
function atoms(value: string) {
  return BigInt(value);
}
type Action = 'review' | 'save' | 'retry' | 'recover' | 'preview';
const URL = '/api/imported-projects/counter-budgets';
const BACKUP_PREFIX = `${COUNTER_BUY_BUDGET_REMINDER}.`;
const backupKey = (value: Reminder) =>
  `${BACKUP_PREFIX}${value.review.selection.budgetId}.${value.review.reviewSha256}`;
function readReminder(text: string) {
  if (text.length > 65536) throw Error('storage-size');
  return parseCounterBudgetReminder(JSON.parse(text));
}
function localRecords() {
  const values: Reminder[] = [];
  if (localStorage.length > 2048) throw Error('storage-index-size');
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(BACKUP_PREFIX)) continue;
    if (values.length >= 20) throw Error('storage-record-limit');
    const value = readReminder(localStorage.getItem(key)!);
    if (backupKey(value) !== key) throw Error('storage-identity');
    values.push(value);
  }
  return values.sort((a, b) => backupKey(a).localeCompare(backupKey(b)));
}
function backup(value: Reminder) {
  const key = backupKey(value),
    text = JSON.stringify(value),
    existing = localStorage.getItem(key);
  if (existing !== null && existing !== text) throw Error('immutable-backup');
  if (existing === null && localRecords().length >= 20)
    throw Error('storage-record-limit');
  if (existing === null) localStorage.setItem(key, text);
  if (localStorage.getItem(key) !== text) throw Error('storage');
}
// Success/error bodies are bounded here; no shared error helper or server module enters this client.
async function body(response: Response, signal: AbortSignal): Promise<unknown> {
  if (
    !response.headers
      .get('content-type')
      ?.toLowerCase()
      .includes('application/json')
  )
    throw Error('format');
  const reader = response.body?.getReader();
  if (!reader) throw Error('body');
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw Error('aborted');
      const next = await reader.read();
      if (signal.aborted) throw Error('aborted');
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 65536) throw Error('size');
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => undefined);
  }
}
function remember(value: Reminder) {
  const text = JSON.stringify(value);
  const existing = localStorage.getItem(COUNTER_BUY_BUDGET_REMINDER);
  if (existing !== null && existing !== text) throw Error('existing-reminder');
  backup(value);
  localStorage.setItem(COUNTER_BUY_BUDGET_REMINDER, text);
  if (localStorage.getItem(COUNTER_BUY_BUDGET_REMINDER) !== text)
    throw Error('storage');
}
function forget(value: Reminder) {
  const existing = localStorage.getItem(COUNTER_BUY_BUDGET_REMINDER);
  if (existing !== null && existing !== JSON.stringify(value))
    throw Error('different-pointer');
  localStorage.removeItem(COUNTER_BUY_BUDGET_REMINDER);
  if (localStorage.getItem(COUNTER_BUY_BUDGET_REMINDER) !== null)
    throw Error('storage');
}
export function CounterBuyBudgetSetup({
  plan,
  decisionIdentity,
  wallet,
  maximumSolInputRaw,
  maximumFeeAndRentRaw,
  locked,
}: Props) {
  const id = useId(),
    pending = useRef<{
      controller: AbortController;
      timer: ReturnType<typeof setTimeout>;
      kind: Action;
    } | null>(null);
  const area = useRef<HTMLElement>(null),
    heading = useRef<HTMLHeadingElement>(null);
  const [input, setInput] = useState(''),
    [fee, setFee] = useState(''),
    [expiry, setExpiry] = useState('');
  const [draftId, setDraftId] = useState<string | null>(null),
    [review, setReview] = useState<CounterBudgetReview | null>(null),
    [consent, setConsent] = useState(false);
  const [reminder, setReminder] = useState<Reminder | null>(null),
    [storageReady, setStorageReady] = useState(false),
    [storageError, setStorageError] = useState(false);
  const [records, setRecords] = useState<Reminder[]>([]),
    [newDraftAllowed, setNewDraftAllowed] = useState(false);
  const [saved, setSaved] = useState<CounterBudgetSaved | null>(null),
    [preview, setPreview] = useState<CounterBudgetPreview | null>(null);
  const [retryReady, setRetryReady] = useState(false),
    [retryConsent, setRetryConsent] = useState(false);
  const [busy, setBusy] = useState<Action | null>(null),
    [error, setError] = useState(''),
    [status, setStatus] = useState(''),
    [signIn, setSignIn] = useState(false),
    [now, setNow] = useState(() => Date.now());
  const key = JSON.stringify([
    plan.id,
    plan.revision,
    plan.state,
    plan.ledger,
    decisionIdentity,
    wallet,
    maximumSolInputRaw,
    maximumFeeAndRentRaw,
    locked,
  ]);
  const live = useRef(key),
    [rendered, setRendered] = useState(key);
  if (rendered !== key) {
    setRendered(key);
    setReview(null);
    setConsent(false);
    setPreview(null);
    setBusy(null);
    setError(
      busy === 'save' || busy === 'retry'
        ? `Save outcome unknown for original ID ${reminder?.review.selection.budgetId ?? draftId}. Recover that ID; no replacement was created.`
        : '',
    );
    setStatus('');
    setRetryReady(false);
    setRetryConsent(false);
  }
  useLayoutEffect(() => {
    live.current = key;
    if (pending.current) {
      clearTimeout(pending.current.timer);
      pending.current.controller.abort();
      pending.current = null;
    }
  }, [key]);
  useEffect(() => {
    let mounted = true;
    void Promise.resolve().then(() => {
      if (!mounted) return;
      try {
        setRecords(localRecords());
        const text = localStorage.getItem(COUNTER_BUY_BUDGET_REMINDER);
        if (text !== null) {
          const old = readReminder(text);
          setReminder(old);
          setDraftId(old.review.selection.budgetId);
        }
      } catch {
        setStorageError(true);
      }
      setStorageReady(true);
    });
    return () => {
      mounted = false;
      if (pending.current) {
        clearTimeout(pending.current.timer);
        pending.current.controller.abort();
        pending.current = null;
      }
    };
  }, []);
  useEffect(() => {
    function changed(event: StorageEvent) {
      if (
        event.storageArea !== localStorage ||
        (event.key !== null &&
          event.key !== COUNTER_BUY_BUDGET_REMINDER &&
          !event.key.startsWith(BACKUP_PREFIX))
      )
        return;
      if (pending.current) {
        clearTimeout(pending.current.timer);
        pending.current.controller.abort();
        pending.current = null;
      }
      setBusy(null);
      setConsent(false);
      setReview(null);
      setPreview(null);
      setSaved(null);
      setRetryReady(false);
      setRetryConsent(false);
      setStatus('');
      setStorageError(true);
      setError(
        'The original-ID reminder changed in another tab. Reload to inspect it before any further metadata save.',
      );
    }
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  useEffect(() => {
    if (!review && !saved && !preview && !reminder) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [review, saved, preview, reminder]);
  const proposal = plan.ledger.decisions.find(
    (d) => d.identity === decisionIdentity && d.outcome === 'proposal',
  );
  let amounts: { input: string; fee: string; expiresAt: string } | null = null;
  try {
    const a = counterBudgetLamports(input),
      b = counterBudgetLamports(fee);
    const expiresAt = new Date(`${expiry}:00.000Z`).toISOString();
    if (
      atoms(a) > 0n &&
      atoms(a) + atoms(b) <= 9007199254740991n &&
      maximumSolInputRaw &&
      maximumFeeAndRentRaw &&
      atoms(a) >= atoms(maximumSolInputRaw) &&
      atoms(b) >= atoms(maximumFeeAndRentRaw) &&
      Date.parse(expiresAt) > now &&
      Date.parse(expiresAt) <= now + 31 * 86400000
    )
      amounts = { input: a, fee: b, expiresAt };
  } catch {
    /* Explicit canonical amounts and UTC expiry are required. */
  }
  const contextReason = locked
    ? 'Counter controls are busy or unavailable.'
    : plan.state !== 'active' || plan.rules.responseSide !== 'Buy' || !proposal
      ? 'Choose a current saved Buy proposal.'
      : !wallet
        ? 'Choose a verified wallet above.'
        : !maximumSolInputRaw || !maximumFeeAndRentRaw
          ? 'Set the per-order limits above first.'
          : '';
  const unresolved = reminder !== null && saved === null;
  const needsChoice =
    records.length > 0 && !reminder && !saved && !newDraftAllowed;
  const originalExpired =
    reminder !== null && Date.parse(reminder.review.selection.expiresAt) <= now;
  const reviewReason = !storageReady
    ? 'Checking the local save reminder…'
    : storageError
      ? 'The original save reminder cannot be read safely. Keep it intact and recover it before saving more metadata.'
      : unresolved
        ? 'Recover the original budget ID before another save.'
        : saved
          ? 'This original budget is saved. Its limits and expiry cannot be renewed here.'
          : needsChoice
            ? 'Choose an original locally retained budget below and recover its history first.'
            : contextReason ||
              (!amounts
                ? 'Enter totals covering the per-order limits and a future UTC expiry within 31 days.'
                : '');
  const matchingSaved =
    saved &&
    reminder &&
    wallet &&
    saved.budget.state === 'open' &&
    Date.parse(saved.budget.terms.expiresAt) > now &&
    reminder.review.selection.projectId === plan.projectId &&
    reminder.review.selection.projectRevision === plan.ledger.scope.revision &&
    reminder.review.selection.planId === plan.id &&
    reminder.review.selection.planRevision === plan.revision &&
    reminder.review.selection.decisionIdentity === decisionIdentity &&
    reminder.review.selection.wallet === wallet.address &&
    reminder.review.selection.walletRevision === wallet.revision;
  let previewReason = contextReason;
  if (!previewReason) {
    if (!matchingSaved || !saved)
      previewReason = 'Recover or save this exact current budget first.';
    else if (
      !maximumSolInputRaw ||
      !maximumFeeAndRentRaw ||
      atoms(maximumSolInputRaw) > atoms(saved.budget.remainingInputLamports) ||
      atoms(maximumFeeAndRentRaw) >
        atoms(saved.budget.remainingFeeAndRentLamports)
    )
      previewReason =
        'The saved accounting remainder does not cover these per-order limits.';
  }
  function focusResult() {
    if (
      document.activeElement === document.body ||
      area.current?.contains(document.activeElement)
    )
      heading.current?.focus();
  }
  function cancel() {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    clearTimeout(p.timer);
    p.controller.abort();
    setBusy(null);
    setStatus('');
    setConsent(false);
    setRetryReady(false);
    setRetryConsent(false);
    setError(
      p.kind === 'save' || p.kind === 'retry'
        ? 'Save outcome unknown. Recover the original budget ID; do not save another ID.'
        : 'Request cancelled. Nothing was automatically retried.',
    );
  }
  async function run(kind: Action) {
    if (pending.current || !storageReady || storageError) return;
    if (
      kind === 'retry' &&
      reminder &&
      Date.parse(reminder.review.selection.expiresAt) <= Date.now()
    ) {
      setNow(Date.now());
      setRetryConsent(false);
      setError(
        'The original metadata expiry has passed. Recover its history; the original save cannot be retried or renewed here.',
      );
      return;
    }
    if (
      (kind === 'review' && reviewReason) ||
      (kind === 'save' &&
        (!review ||
          !consent ||
          unresolved ||
          saved ||
          locked ||
          Date.parse(review.selection.expiresAt) <= Date.now())) ||
      (kind === 'retry' &&
        (!reminder ||
          !retryReady ||
          !retryConsent ||
          saved ||
          locked ||
          Date.parse(reminder.review.selection.expiresAt) <= Date.now())) ||
      (kind === 'recover' && !reminder) ||
      (kind === 'preview' && previewReason)
    )
      return;
    const captured = key,
      c = new AbortController();
    const writing = kind === 'save' || kind === 'retry';
    let reviewed = review,
      request: CounterBudgetPreviewRequest | null = null,
      payload: unknown = null;
    if (kind === 'review') {
      if (!amounts || !wallet) return;
      const originalId = draftId ?? crypto.randomUUID();
      setDraftId(originalId);
      const selection: CounterBudgetSelection = {
        budgetId: originalId,
        projectId: plan.projectId,
        projectRevision: plan.ledger.scope.revision,
        planId: plan.id,
        planRevision: plan.revision,
        decisionIdentity,
        wallet: wallet.address,
        walletRevision: wallet.revision,
        maximumInputLamports: amounts.input,
        maximumFeeAndRentLamports: amounts.fee,
        expiresAt: amounts.expiresAt,
      };
      payload = { ...selection, action: 'review' };
    } else if (writing) {
      if (kind === 'retry') reviewed = reminder!.review;
      if (!reviewed) return;
      try {
        const original = counterBudgetReminder(reviewed);
        remember(original);
        setReminder(original);
        setRecords(localRecords());
      } catch {
        setStorageError(true);
        setError(
          'The original ID could not be stored and verified. No save request was sent.',
        );
        return;
      }
      payload = {
        ...reviewed.selection,
        action: 'save',
        reviewSha256: reviewed.reviewSha256,
        acknowledgement: COUNTER_BUY_METADATA_ACK,
      };
    } else if (kind === 'recover') {
      reviewed = reminder!.review;
    } else if (
      kind === 'preview' &&
      saved &&
      wallet &&
      maximumSolInputRaw &&
      maximumFeeAndRentRaw
    ) {
      request = {
        budgetId: saved.originalId,
        budgetRevision: saved.budget.revision,
        strategyId: plan.id,
        projectId: plan.projectId,
        projectRevision: plan.ledger.scope.revision,
        planId: plan.id,
        planRevision: plan.revision,
        decisionIdentity,
        wallet: wallet.address,
        walletRevision: wallet.revision,
        maximumSolInputRaw,
        maximumFeeAndRentRaw,
      };
      payload = request;
    } else return;
    const timer = setTimeout(
      () => {
        if (pending.current?.controller !== c) return;
        pending.current = null;
        c.abort();
        setBusy(null);
        setConsent(false);
        setRetryReady(false);
        setRetryConsent(false);
        setStatus('');
        setError(
          writing
            ? 'Save outcome unknown. Recover the original budget ID; do not save another ID.'
            : 'Request timed out. Nothing was automatically retried.',
        );
        focusResult();
      },
      kind === 'preview' ? 45000 : 15000,
    );
    pending.current = { controller: c, timer, kind };
    setBusy(kind);
    setError('');
    setStatus('');
    setSignIn(false);
    setPreview(null);
    setConsent(false);
    setRetryReady(false);
    setRetryConsent(false);
    if (kind === 'review') setReview(null);
    const active = () =>
      pending.current?.controller === c &&
      !c.signal.aborted &&
      live.current === captured;
    try {
      const response = await fetch(
        kind === 'recover'
          ? `${URL}?id=${encodeURIComponent(reviewed!.selection.budgetId)}`
          : kind === 'preview'
            ? '/api/imported-projects/counter-budget-previews'
            : URL,
        {
          ...(payload
            ? {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
              }
            : { method: 'GET' }),
          cache: 'no-store',
          signal: c.signal,
        },
      );
      if (!active()) return;
      if (response.status === 401) {
        setSignIn(true);
        throw Error('signin');
      }
      if (!response.ok) {
        if (kind === 'recover' && response.status === 404) {
          const missing = await body(response, c.signal);
          if (!active()) return;
          if (
            missing !== null &&
            typeof missing === 'object' &&
            !Array.isArray(missing) &&
            Object.keys(missing).length === 1 &&
            (missing as { error?: unknown }).error ===
              'Owned budget history not found.'
          ) {
            setRetryReady(true);
            setNow(Date.now());
            setError(
              'The signed-in lookup found no record for this original ID. You may explicitly retry only its exact original metadata save. A lookup does not prove an earlier request cannot finish.',
            );
            return;
          }
        }
        if (writing && reviewed) {
          let data: unknown = null;
          try {
            data = await body(response, c.signal);
          } catch {
            /* Unreadable refusals remain ambiguous. */
          }
          if (!active()) return;
          if (
            kind === 'save' &&
            isCounterBudgetPrewriteRefusal(data, reviewed)
          ) {
            try {
              forget(counterBudgetReminder(reviewed));
              setReminder(null);
              setReview(null);
              setSaved(null);
              setNewDraftAllowed(true);
            } catch {
              setStorageError(true);
              throw Error('storage');
            }
            setError(
              'The server confirmed this request did not attempt a write. An earlier record may still exist. Review the current metadata again using the same original ID.',
            );
            return;
          }
        }
        throw Error('request');
      }
      const data = await body(response, c.signal);
      if (!active()) return;
      if (kind === 'review') {
        const { action: _action, ...expected } =
          payload as CounterBudgetSelection & { action: string };
        setReview(admitCounterBudgetReview(data, expected, plan));
        setStatus(
          'Exact accounting limits reviewed. Check the separate save acknowledgement to continue.',
        );
      } else if ((writing || kind === 'recover') && reviewed) {
        const result = admitCounterBudgetSaved(data, reviewed);
        setSaved(result);
        setReview(null);
        setStatus(
          writing
            ? 'Immutable accounting terms saved or recovered. Trading remains disabled here.'
            : 'Original accounting record recovered. Its original limits and expiry are unchanged.',
        );
      } else if (kind === 'preview' && request && saved) {
        setPreview(admitCounterBudgetPreview(data, plan, request, saved));
        setStatus(
          'Read-only budget preview loaded. No funds or accounting capacity were reserved.',
        );
      }
      setNow(Date.now());
    } catch {
      if (active())
        setError(
          writing
            ? 'Save outcome unknown. Recover the original budget ID; do not save another ID.'
            : kind === 'recover'
              ? 'The original record could not be recovered. Keep this ID and try its read-only recovery again. No replacement was created.'
              : 'The selected metadata request is unavailable or differs from the expected record. Request a fresh review.',
        );
    } finally {
      if (pending.current?.controller === c) {
        clearTimeout(timer);
        pending.current = null;
        setBusy(null);
        focusResult();
      }
    }
  }
  const disabled =
    !!busy ||
    locked ||
    !storageReady ||
    storageError ||
    !!reminder ||
    !!saved ||
    needsChoice;
  function anotherBudget() {
    if (pending.current || !saved || !reminder || storageError) return;
    try {
      backup(reminder);
      forget(reminder);
      setRecords(localRecords());
      setReminder(null);
      setSaved(null);
      setReview(null);
      setPreview(null);
      setDraftId(null);
      setInput('');
      setFee('');
      setExpiry('');
      setConsent(false);
      setRetryReady(false);
      setRetryConsent(false);
      setNewDraftAllowed(true);
      setError('');
      setStatus(
        'Previous immutable terms kept for explicit history recovery. Set separate totals for a new budget.',
      );
    } catch {
      setStorageError(true);
      setError(
        'The previous original-ID backup or matching active reminder could not be verified. No new draft was created.',
      );
    }
  }
  return (
    <section
      ref={area}
      className={styles.panel}
      aria-label="Counter accounting budget"
    >
      <h4 ref={heading} tabIndex={-1}>
        Buy budget
      </h4>
      <p>Saving limits does not enable trading or reserve funds.</p>
      {records.length > 0 && (
        <details className={styles.details} open={needsChoice}>
          <summary>
            Locally retained budget history ({records.length}/20)
          </summary>
          <label htmlFor={`${id}-history`}>Original budget and review</label>
          <select
            id={`${id}-history`}
            className={styles.history}
            disabled={!!busy || storageError}
            value={
              reminder &&
              records.some((r) => backupKey(r) === backupKey(reminder))
                ? backupKey(reminder)
                : ''
            }
            onChange={(event) => {
              const selected = records.find(
                (r) => backupKey(r) === event.target.value,
              );
              if (!selected) return;
              setReminder(selected);
              setDraftId(selected.review.selection.budgetId);
              setReview(null);
              setSaved(null);
              setPreview(null);
              setConsent(false);
              setRetryReady(false);
              setRetryConsent(false);
              setError('');
              setStatus(
                'Original metadata selected. Use read-only recovery to verify the account record.',
              );
            }}
          >
            <option value="">Choose an original record explicitly</option>
            {records.map((r) => (
              <option key={backupKey(r)} value={backupKey(r)}>
                {r.review.selection.budgetId} ·{' '}
                {r.review.reviewSha256.slice(0, 12)}
              </option>
            ))}
          </select>
          <p>
            Local copies preserve original IDs and reviewed metadata, not server
            save outcomes. No request runs when choosing a record. Active
            reminders are checked before any removal; cross-tab storage is not
            an atomic lock.
          </p>
        </details>
      )}
      {!reminder && !saved && (
        <>
          <div className={styles.fields}>
            <label htmlFor={`${id}-input`}>
              Total swap budget (SOL)
              <Input
                id={`${id}-input`}
                inputMode="decimal"
                maxLength={24}
                disabled={disabled}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setReview(null);
                  setConsent(false);
                }}
              />
            </label>
            <label htmlFor={`${id}-fee`}>
              Total fees and rent (SOL)
              <Input
                id={`${id}-fee`}
                inputMode="decimal"
                maxLength={24}
                disabled={disabled}
                value={fee}
                onChange={(e) => {
                  setFee(e.target.value);
                  setReview(null);
                  setConsent(false);
                }}
              />
            </label>
            <label htmlFor={`${id}-expiry`}>
              Original expiry (UTC)
              <Input
                id={`${id}-expiry`}
                type="datetime-local"
                disabled={disabled}
                value={expiry}
                onChange={(e) => {
                  setExpiry(e.target.value);
                  setReview(null);
                  setConsent(false);
                }}
              />
            </label>
          </div>
          <p>
            {wallet
              ? `Selected wallet: ${wallet.label || wallet.address}`
              : 'Choose a verified wallet above.'}
          </p>
          <p id={`${id}-reason`}>
            {reviewReason ||
              'Totals cover the current per-order limits. Review them before saving.'}
          </p>
          <Button
            type="button"
            disabled={!!busy || !!reviewReason}
            aria-describedby={`${id}-reason`}
            onClick={() => void run('review')}
          >
            Review accounting limits
          </Button>
        </>
      )}
      {review && !reminder && (
        <>
          <dl className={styles.summary}>
            <div>
              <dt>Total swap budget</dt>
              <dd>{counterBudgetSol(review.terms.maximumInputLamports)} SOL</dd>
            </div>
            <div>
              <dt>Total fees and rent</dt>
              <dd>
                {counterBudgetSol(review.terms.maximumFeeAndRentLamports)} SOL
              </dd>
            </div>
            <div>
              <dt>Original expiry</dt>
              <dd>{review.terms.expiresAt} (UTC)</dd>
            </div>
          </dl>
          <label className={styles.consent}>
            <input
              type="checkbox"
              checked={consent}
              disabled={
                !!busy ||
                locked ||
                Date.parse(review.selection.expiresAt) <= now
              }
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span>{COUNTER_BUY_METADATA_ACK}</span>
          </label>
          <Button
            type="button"
            disabled={
              !consent ||
              !!busy ||
              locked ||
              Date.parse(review.selection.expiresAt) <= now
            }
            onClick={() => void run('save')}
          >
            Save accounting metadata
          </Button>
        </>
      )}
      {reminder && !saved && (
        <>
          <p>One original save needs recovery. No new save will be sent.</p>
          <Button
            type="button"
            disabled={!!busy || storageError}
            onClick={() => void run('recover')}
          >
            Recover original budget ID
          </Button>
          {retryReady && originalExpired && (
            <p>
              The original metadata expiry has passed. This unwritten original
              cannot be renewed or retried here. Its read-only history lookup
              remains available.
            </p>
          )}
          {retryReady && !originalExpired && (
            <>
              <label className={styles.consent}>
                <input
                  type="checkbox"
                  checked={retryConsent}
                  disabled={!!busy || locked || storageError}
                  onChange={(e) => setRetryConsent(e.target.checked)}
                />
                <span>
                  The signed-in lookup found no record. I approve retrying the
                  exact original accounting metadata save, with the same ID,
                  limits, expiry and review hash. This does not authorize trades
                  or reserve funds.
                </span>
              </label>
              <Button
                type="button"
                disabled={!!busy || locked || storageError || !retryConsent}
                onClick={() => void run('retry')}
              >
                Retry original metadata save
              </Button>
            </>
          )}
        </>
      )}
      {saved && (
        <>
          <p>
            Saved accounting limits · {saved.budget.state}.{' '}
            {Date.parse(saved.budget.terms.expiresAt) <= now
              ? 'Original expiry has passed; this historical record remains saved.'
              : 'Original expiry is unchanged.'}
          </p>
          <dl className={styles.summary}>
            <div>
              <dt>Swap budget remaining</dt>
              <dd>
                {counterBudgetSol(saved.budget.remainingInputLamports)} SOL
              </dd>
            </div>
            <div>
              <dt>Fees and rent remaining</dt>
              <dd>
                {counterBudgetSol(saved.budget.remainingFeeAndRentLamports)} SOL
              </dd>
            </div>
          </dl>
          {saved.currentContext === 'changed-or-unavailable-after-write' && (
            <p>
              Metadata was saved, but the current Counter context changed or
              could not be checked afterwards.
            </p>
          )}
          <p id={`${id}-preview-reason`}>
            {previewReason ||
              'Preview this exact budget and the current per-order limits. This does not reserve capacity.'}
          </p>
          <Button
            type="button"
            disabled={!!busy || !!previewReason}
            aria-describedby={`${id}-preview-reason`}
            onClick={() => void run('preview')}
          >
            Preview saved budget
          </Button>
          <Button
            type="button"
            disabled={!!busy}
            onClick={() => void run('recover')}
          >
            Refresh original record
          </Button>
          <Button
            type="button"
            disabled={!!busy || storageError}
            onClick={anotherBudget}
          >
            Set up another budget
          </Button>
        </>
      )}
      {preview && (
        <div className={styles.result}>
          <p>
            {Date.parse(preview.expiresAt) <= now
              ? 'Budget preview expired. Request a fresh preview.'
              : 'Read-only budget preview · not reservable'}
          </p>
          <dl className={styles.summary}>
            <div>
              <dt>Simulated swap input</dt>
              <dd>{counterBudgetSol(preview.actualSimulatedInputRaw)} SOL</dd>
            </div>
            <div>
              <dt>Network fee</dt>
              <dd>{counterBudgetSol(preview.networkFeeLamports)} SOL</dd>
            </div>
            <div>
              <dt>Accounting swap remainder at preview</dt>
              <dd>{counterBudgetSol(preview.remainingInputLamports)} SOL</dd>
            </div>
            <div>
              <dt>Accounting fee/rent remainder at preview</dt>
              <dd>
                {counterBudgetSol(preview.remainingFeeAndRentLamports)} SOL
              </dd>
            </div>
          </dl>
          <p>
            No trading approval, fund reservation or executable claim was
            created.
          </p>
        </div>
      )}
      {(review || reminder || saved) && (
        <details className={styles.details}>
          <summary>Record details and limitations</summary>
          <p>
            Original ID:{' '}
            {saved?.originalId ||
              reminder?.review.selection.budgetId ||
              review?.selection.budgetId}
          </p>
          <p>
            Review hash: {reminder?.review.reviewSha256 || review?.reviewSha256}
          </p>
          <p>
            {saved?.limitations ||
              reminder?.review.limitations ||
              review?.limitations}
          </p>
          <p>
            Wallet, strategy and overall caps use the same single-wallet totals.
            The original review hash and decision are not stored in these
            immutable terms. Saved rows are permanent accounting metadata; these
            are not wallet balances or capacity reservations.
          </p>
        </details>
      )}
      {busy && (
        <Button type="button" onClick={cancel}>
          Cancel request
        </Button>
      )}
      <output aria-live="polite">
        {busy ? 'Reading the explicitly selected accounting request…' : status}
      </output>
      <div role="alert">
        {error ||
          (storageError
            ? 'The local original-ID reminder is unavailable. Saving is blocked to avoid losing recovery information.'
            : '')}
      </div>
      {signIn && (
        <Link className={styles.signIn} href="/sign-in">
          Sign in to recover your account record
        </Link>
      )}
    </section>
  );
}
