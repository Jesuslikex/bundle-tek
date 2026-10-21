'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
import type { WalletWarmupSessionView } from '@/lib/wallet-warmup-session-view';
import type { RetainedWarmupSessionSummary } from '@/lib/wallet-warmup-session-retained-view';
import {
  warmupV2Preview,
  warmupV2Saved,
  warmupV2Journal,
  warmupV2AbsentControl,
  warmupV2Reminder,
  type WarmupV2Preview,
  type WarmupV2Saved,
  type WarmupV2Journal,
  type WarmupV2Reminder,
} from '@/lib/wallet-warmup-session-v2-view';
import { readWarmupConsentResponse } from '@/lib/wallet-warmup-session-consent-view';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { WARMUP_RECEIPT_SAVED } from '@/lib/warmup-receipt-events';
import { Button } from './ui/button';
import styles from './wallet-warmup-session-v2.module.css';
import { WalletWarmupSessionV2Attempt } from './wallet-warmup-session-v2-attempt';
type Props = {
  plan: SavedWarmup;
  view: WalletWarmupSessionView | null;
  retained: RetainedWarmupSessionSummary;
  onBusyChange: (value: boolean) => void;
};
const consentEndpoint = '/api/wallet-workspace/warmup/session-v2-consents',
  journalEndpoint = '/api/wallet-workspace/warmup/session-v2-journals';
const validId = (id: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    id,
  );
class SessionReadError extends Error {}
const quantity = (n: number, label: string) =>
  `${n} ${label}${n === 1 ? '' : 's'}`;
export function WalletWarmupSessionV2(props: Props) {
  return (
    <SessionPanel
      key={JSON.stringify([
        props.plan,
        props.retained.id,
        props.view?.review.contextKey ?? null,
      ])}
      {...props}
    />
  );
}
function SessionPanel({ plan, view, retained, onBusyChange }: Props) {
  const key = 'bundle:warmup-v2:' + plan.id,
    active = useRef<AbortController | null>(null),
    mounted = useRef(false),
    stored = useRef<string | null>(null);
  const panelHeading = useRef<HTMLHeadingElement | null>(null),
    consentHeading = useRef<HTMLHeadingElement | null>(null),
    journalHeading = useRef<HTMLHeadingElement | null>(null),
    focusTarget = useRef<'panel' | 'consent' | 'journal' | null>(null);
  const [busy, setBusy] = useState(false),
    [prepared, setPrepared] = useState<WarmupV2Preview | null>(null),
    [consent, setConsent] = useState<WarmupV2Saved | null>(null),
    [journal, setJournal] = useState<WarmupV2Journal | null>(null),
    [marker, setMarker] = useState<WarmupV2Reminder | null>(null),
    [invalid, setInvalid] = useState(false),
    [approved, setApproved] = useState(false),
    [historyChecked, setHistoryChecked] = useState(false),
    [controlChecked, setControlChecked] = useState(false),
    [finish, setFinish] = useState(1),
    [id, setId] = useState(''),
    [historyId, setHistoryId] = useState(''),
    [notice, setNotice] = useState(''),
    [error, setError] = useState(''),
    [sourceDirty, setSourceDirty] = useState(false),
    [clock, setClock] = useState(() => Date.now()),
    [hint, setHint] = useState<{
      kind: 'consent' | 'record';
      id: string;
    } | null>(null);
  const [stopChecked, setStopChecked] = useState(false),
    [archiveChecked, setArchiveChecked] = useState(false),
    [missingRecord, setMissingRecord] = useState(false),
    [archives, setArchives] = useState<string[]>([]),
    [archivePage, setArchivePage] = useState(0),
    [baselineChanged, setBaselineChanged] = useState(false);
  const archivePrefix = key + ':archive:';
  useEffect(() => {
    mounted.current = true;
    void Promise.resolve().then(() => {
      if (!mounted.current) return;
      try {
        setArchives(
          Array.from({ length: sessionStorage.length }, (_, i) =>
            sessionStorage.key(i),
          ).filter((v): v is string => !!v && v.startsWith(archivePrefix)),
        );
        const raw = sessionStorage.getItem(key);
        stored.current = raw;
        if (raw) {
          const next = warmupV2Reminder(JSON.parse(raw), plan.id);
          setMarker(next);
          setId(next.consentId);
          setHistoryId(
            next.journalId ??
              (next.request?.kind === 'record' ? next.request.id : ''),
          );
          setNotice(
            'Saved recovery IDs are available. Recover the original session before changing it.',
          );
        }
      } catch {
        setInvalid(true);
        setError(
          'The local session reminder is unreadable. Recover known IDs before changing it.',
        );
      }
    });
    const tick = setInterval(() => setClock(Date.now()), 1000);
    return () => {
      mounted.current = false;
      active.current?.abort();
      active.current = null;
      clearInterval(tick);
    };
  }, [key, plan.id, archivePrefix]);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    const node =
      focusTarget.current === 'panel'
        ? panelHeading.current
        : focusTarget.current === 'consent'
          ? consentHeading.current
          : focusTarget.current === 'journal'
            ? journalHeading.current
            : null;
    if (mounted.current && node) {
      focusTarget.current = null;
      node.focus();
    }
  }, [consent, journal, marker, invalid]);
  function showConsent(value: WarmupV2Saved) {
    focusTarget.current = 'consent';
    setConsent((previous) =>
      previous &&
      previous.id === value.id &&
      previous.termsSha256 === value.termsSha256
        ? previous
        : value,
    );
  }
  function showJournal(value: WarmupV2Journal) {
    focusTarget.current = 'journal';
    setJournal(value);
  }
  useEffect(() => {
    const invalidate = () => {
      focusTarget.current = null;
      active.current?.abort();
      active.current = null;
      setBusy(false);
      setApproved(false);
      setHistoryChecked(false);
      setControlChecked(false);
      setStopChecked(false);
      setPrepared(null);
      setSourceDirty(true);
      setNotice(
        'Context changed. Recover pending requests and request a fresh source review before new work.',
      );
    };
    const receipt = (event: Event) => {
      if ((event as CustomEvent).detail?.planId === plan.id) {
        setBaselineChanged(true);
        invalidate();
      }
    };
    window.addEventListener('pagehide', invalidate);
    const storage = (event: StorageEvent) => {
      if (event instanceof StorageEvent && event.storageArea !== sessionStorage)
        return;
      if (
        event instanceof StorageEvent &&
        event.key !== null &&
        event.key !== key
      )
        return;
      invalidate();
    };
    window.addEventListener('storage', storage);
    window.addEventListener(WARMUP_RECEIPT_SAVED, receipt);
    return () => {
      window.removeEventListener('pagehide', invalidate);
      window.removeEventListener('storage', storage);
      window.removeEventListener(WARMUP_RECEIPT_SAVED, receipt);
    };
  }, [plan.id, key]);
  const live = useCallback(
    (controller: AbortController) =>
      mounted.current &&
      active.current === controller &&
      !controller.signal.aborted,
    [],
  );
  function remember(next: WarmupV2Reminder) {
    const checked = warmupV2Reminder(next, plan.id);
    if (sessionStorage.getItem(key) !== stored.current)
      throw Error('Local reminder changed');
    const document = JSON.stringify(checked);
    sessionStorage.setItem(key, document);
    if (sessionStorage.getItem(key) !== document)
      throw Error('Local reminder was not retained');
    stored.current = document;
    setMarker(checked);
    setMissingRecord(false);
    setArchiveChecked(false);
    return checked;
  }
  async function run(work: (controller: AbortController) => Promise<void>) {
    if (active.current) return;
    if (
      typeof AbortSignal.any !== 'function' ||
      typeof AbortSignal.timeout !== 'function'
    ) {
      setError(
        'Update your browser before making session requests. No request or recovery reminder was created.',
      );
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work(controller);
    } catch (error) {
      if (live(controller))
        setError(
          error instanceof SessionReadError
            ? error.message
            : 'Could not confirm this request. Keep the original IDs and use Recover; nothing is retried automatically.',
        );
    } finally {
      if (live(controller)) {
        active.current = null;
        setBusy(false);
      }
    }
  }
  async function request(
    controller: AbortController,
    url: string,
    body?: unknown,
  ) {
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(20000),
    ]);
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const value = await readWarmupConsentResponse(response, signal);
    if (!live(controller)) throw Error('Stale response');
    if (!response.ok) {
      const recovery =
        value && typeof value === 'object' && 'recoveryId' in value
          ? value.recoveryId
          : null;
      const operation =
        body && typeof body === 'object' && 'operation' in body
          ? body.operation
          : null;
      if (
        (response.status === 409 || response.status === 408) &&
        typeof recovery === 'string' &&
        validId(recovery) &&
        (operation === 'save' || operation === 'record')
      )
        setHint({
          kind: operation === 'save' ? 'consent' : 'record',
          id: recovery,
        });
      if (response.status === 404) {
        if (
          !body &&
          marker?.request &&
          marker.request.kind !== 'control' &&
          new URL(url, window.location.origin).searchParams.get('id') ===
            marker.request.id &&
          new URL(url, window.location.origin).pathname ===
            (marker.request.kind === 'consent'
              ? consentEndpoint
              : journalEndpoint)
        )
          setMissingRecord(true);
        throw new SessionReadError(
          'Original record is not found for this account yet. Keep its IDs and check again; do not create a replacement.',
        );
      }
      if (response.status === 401)
        throw new SessionReadError(
          'Sign in again, then recover the original IDs. No request will be resubmitted.',
        );
      if (response.status === 409)
        throw new SessionReadError(
          'The saved context conflicts or changed. Recover existing history before another change.',
        );
      if (response.status === 503)
        throw new SessionReadError(
          'Versioned session storage is unavailable. This local feature may need its approved release migrations; no replacement request was sent.',
        );
      throw new SessionReadError(
        'Session request refused. Recover the original IDs before another change.',
      );
    }
    return value;
  }
  const fresh =
    !!view &&
    view.review.actions.length > 0 &&
    !sourceDirty &&
    !plan.archived &&
    clock < view.deadline &&
    retained.planRevision === plan.revision &&
    retained.reviewedAt === view.review.reviewedAt;
  const last = view?.review.actions.length
    ? Math.max(...view.review.actions.map((a) => Date.parse(a.scheduledAt)))
    : null;
  const finishAt =
    last === null ? '' : new Date(last + finish * 60000).toISOString();
  const pending = !!marker?.request,
    locked = busy || pending || invalid;
  const readTerms = () =>
    run(async (controller) => {
      if (!fresh || !view || locked || consent) return;
      setPrepared(null);
      setApproved(false);
      const value = await request(controller, consentEndpoint, {
        operation: 'review',
        reviewId: retained.id,
        reviewSha256: retained.reviewSha256,
        sessionExpiresAt: finishAt,
      });
      const checked = await warmupV2Preview(
        value,
        plan,
        view,
        retained,
        finishAt,
      );
      if (live(controller)) {
        setPrepared(checked);
        setNotice(
          'Review the finite read policy, amounts and finish deadline. No session has started.',
        );
      }
    });
  const save = () =>
    run(async (controller) => {
      if (!approved || !prepared || !fresh || !view || locked || consent)
        return;
      const checked = await warmupV2Preview(
        {
          consentReview: {
            terms: prepared.terms,
            termsSha256: prepared.termsSha256,
            reviewCreatedAt: prepared.reviewCreatedAt,
            reviewedAt: prepared.reviewedAt,
            reviewExpiresAt: prepared.reviewExpiresAt,
          },
        },
        plan,
        view,
        retained,
        finishAt,
      );
      if (!live(controller) || Date.now() >= checked.deadline) return;
      const consentId = crypto.randomUUID();
      const next = remember({
        format: 'wallet-warmup-v2-reminder-v1',
        planId: plan.id,
        consentId,
        termsSha256: checked.termsSha256,
        journalId: null,
        request: {
          kind: 'consent',
          id: consentId,
          reviewId: retained.id,
          reviewSha256: retained.reviewSha256,
          sessionExpiresAt: finishAt,
        },
      });
      setId(consentId);
      setApproved(false);
      const value = await request(controller, consentEndpoint, {
        operation: 'save',
        id: consentId,
        reviewId: retained.id,
        reviewSha256: retained.reviewSha256,
        sessionExpiresAt: finishAt,
        termsSha256: checked.termsSha256,
        approved: true,
      });
      const saved = await warmupV2Saved(value, {
        id: consentId,
        planId: plan.id,
        termsSha256: next.termsSha256,
      });
      if (live(controller)) {
        remember({ ...next, request: null });
        showConsent(saved);
        setPrepared(null);
        setNotice('Plan approval saved. No trades are running.');
      }
    });
  const recoverConsent = (candidate?: string) =>
    run(async (controller) => {
      const selected =
        candidate && hint?.kind === 'consent' && hint.id === candidate
          ? candidate
          : id;
      const existing =
        !!candidate &&
        hint?.kind === 'consent' &&
        hint.id === candidate &&
        marker?.request?.kind === 'consent';
      if (!validId(selected)) return;
      if (marker && selected !== marker.consentId && !existing)
        throw new SessionReadError(
          'Recover the approval ID in the pending reminder first.',
        );
      const saved = await warmupV2Saved(
        await request(
          controller,
          consentEndpoint + '?id=' + encodeURIComponent(selected),
        ),
        {
          id: selected,
          planId: plan.id,
          termsSha256: existing ? undefined : marker?.termsSha256,
          ...(existing && marker?.request?.kind === 'consent'
            ? {
                reviewId: marker.request.reviewId,
                reviewSha256: marker.request.reviewSha256,
              }
            : {}),
        },
      );
      if (live(controller)) {
        const next = marker ?? {
          format: 'wallet-warmup-v2-reminder-v1' as const,
          planId: plan.id,
          consentId: saved.id,
          termsSha256: saved.termsSha256,
          journalId: null,
          request: null,
        };
        if (!invalid)
          remember({
            ...next,
            consentId: saved.id,
            termsSha256: saved.termsSha256,
            request: next.request?.kind === 'consent' ? null : next.request,
          });
        showConsent(saved);
        setId(saved.id);
        setHint(null);
        setPrepared(null);
        setApproved(false);
        setJournal(null);
        setNotice(
          'Recovered the original approval. Its amounts and finish time were not renewed.',
        );
      }
    });
  const recordHistory = () =>
    run(async (controller) => {
      if (
        !consent ||
        !marker ||
        locked ||
        !historyChecked ||
        journal ||
        marker.journalId
      )
        return;
      const historyId = crypto.randomUUID(),
        next = remember({
          ...marker,
          request: { kind: 'record', id: historyId },
        });
      setHistoryId(historyId);
      setHistoryChecked(false);
      const value = await request(controller, journalEndpoint, {
        operation: 'record',
        id: historyId,
        consentId: consent.id,
        termsSha256: consent.termsSha256,
        recordRequested: true,
      });
      const saved = await warmupV2Journal(value, consent, {
        id: historyId,
        request: next.request,
      });
      if (live(controller)) {
        remember({ ...next, journalId: historyId, request: null });
        showJournal(saved);
        setNotice('History recorded. No activity has started.');
      }
    });
  const recoverHistory = (candidate?: string) =>
    run(async (controller) => {
      const selected =
        candidate && hint?.kind === 'record' && hint.id === candidate
          ? candidate
          : historyId;
      const existing =
        !!candidate &&
        hint?.kind === 'record' &&
        hint.id === candidate &&
        marker?.request?.kind === 'record';
      if (!consent || !validId(selected)) return;
      const bound =
        marker?.journalId ??
        (marker?.request?.kind === 'record' ? marker.request.id : null);
      if (bound && bound !== selected && !existing)
        throw new SessionReadError(
          'Recover the history ID in the pending reminder first.',
        );
      const expectedControl = marker?.stopRequest ?? marker?.request;
      const event =
        expectedControl?.kind === 'control' ? expectedControl.id : null;
      const value = await request(
        controller,
        journalEndpoint +
          '?id=' +
          encodeURIComponent(selected) +
          (event ? '&eventId=' + event : ''),
      );
      const empty =
        value &&
        typeof value === 'object' &&
        'journal' in value &&
        value.journal &&
        typeof value.journal === 'object' &&
        'commandReceipt' in value.journal &&
        value.journal.commandReceipt === null;
      const absent = expectedControl?.kind === 'control' && empty;
      const saved = absent
        ? await warmupV2AbsentControl(
            value,
            consent,
            expectedControl as Extract<
              NonNullable<WarmupV2Reminder['request']>,
              { kind: 'control' }
            >,
            journal ?? undefined,
          )
        : await warmupV2Journal(value, consent, {
            id: selected,
            request: existing ? null : expectedControl,
            previous: journal ?? undefined,
          });
      if (live(controller)) {
        if (!invalid)
          remember({
            format: 'wallet-warmup-v2-reminder-v1',
            planId: plan.id,
            consentId: consent.id,
            termsSha256: consent.termsSha256,
            journalId: selected,
            request: null,
          });
        showJournal(saved);
        setHistoryId(selected);
        setHint(null);
        setControlChecked(false);
        setStopChecked(false);
        setNotice(
          absent
            ? marker?.stopRequest
              ? 'Stop was not recorded; this saved state had already advanced. Review the current status before another control.'
              : 'The earlier control was not recorded and its predecessor has advanced. Recovered current history; no retry was sent.'
            : 'Original history recovered. No action was retried or deadline renewed.',
        );
      }
    });
  const control = (control: 'begin-review' | 'pause' | 'resume' | 'stop') =>
    run(async (controller) => {
      if (!consent || !journal || !marker || locked || !controlChecked) return;
      const command = {
        kind: 'control' as const,
        id: crypto.randomUUID(),
        journalId: journal.id,
        version: journal.version,
        headSha256: journal.headSha256,
        control,
      };
      const next = remember({ ...marker, request: command });
      setControlChecked(false);
      const { kind: _kind, ...selection } = command;
      const value = await request(controller, journalEndpoint, {
        operation: 'control',
        ...selection,
      });
      const saved = await warmupV2Journal(value, consent, {
        id: journal.id,
        request: command,
        previous: journal,
      });
      if (live(controller)) {
        remember({ ...next, request: null });
        showJournal(saved);
        setNotice(
          control === 'stop'
            ? 'Session history stopped. Pending review is preserved; no transaction was cancelled or sent.'
            : 'Control recorded. No qualification, signing or trades are enabled.',
        );
      }
    });
  const stopPending = () =>
    run(async (controller) => {
      if (
        !consent ||
        !marker ||
        marker.request?.kind !== 'control' ||
        !stopChecked ||
        invalid
      )
        return;
      const command = marker.stopRequest ?? {
        ...marker.request,
        id: crypto.randomUUID(),
        control: 'stop' as const,
      };
      const next = remember({ ...marker, stopRequest: command });
      setStopChecked(false);
      const { kind: _kind, ...selection } = command;
      const value = await request(controller, journalEndpoint, {
        operation: 'control',
        ...selection,
      });
      const saved = await warmupV2Journal(value, consent, {
        id: command.journalId,
        request: command,
        previous: journal ?? undefined,
      });
      if (live(controller)) {
        remember({ ...next, request: null, stopRequest: undefined });
        showJournal(saved);
        setHistoryId(saved.id);
        setNotice(
          'Stop recorded against the original pending state. The competing earlier control cannot also commit that version. Pending review and history are preserved.',
        );
      }
    });
  const ended =
      !!consent && clock >= Date.parse(consent.terms.sessionExpiresAt),
    changed =
      !!consent &&
      (consent.summary.planRevision !== plan.revision || plan.archived);
  const canArchive =
    invalid ||
    (!!marker &&
      (!marker.request
        ? !marker.journalId ||
          (!!journal &&
            (!journal.snapshot.pendingReview ||
              journal.snapshot.stopped ||
              journal.snapshot.expired))
        : marker.request.kind !== 'control' && missingRecord));
  function archiveReminder() {
    if (busy || !canArchive || !archiveChecked) return;
    try {
      const raw = sessionStorage.getItem(key);
      if (
        !raw ||
        raw !== stored.current ||
        new TextEncoder().encode(raw).byteLength > 3 * 1024 * 1024
      )
        throw Error('Archive unavailable');
      const duplicate = archives.find((k) => sessionStorage.getItem(k) === raw);
      const destination = duplicate ?? archivePrefix + crypto.randomUUID();
      if (!duplicate && sessionStorage.getItem(destination) !== null)
        throw Error('Archive collision');
      sessionStorage.setItem(destination, raw);
      if (
        sessionStorage.getItem(destination) !== raw ||
        sessionStorage.getItem(key) !== raw
      )
        throw Error('Archive not confirmed');
      sessionStorage.removeItem(key);
      if (sessionStorage.getItem(key) !== null) throw Error('Reminder changed');
      stored.current = null;
      focusTarget.current = 'panel';
      setArchives((previous) =>
        previous.includes(destination) ? previous : [...previous, destination],
      );
      setArchivePage(0);
      setMarker(null);
      setInvalid(false);
      setConsent(null);
      setJournal(null);
      setPrepared(null);
      setId('');
      setHistoryId('');
      setHint(null);
      setArchiveChecked(false);
      setApproved(false);
      setHistoryChecked(false);
      setControlChecked(false);
      setStopChecked(false);
      setSourceDirty(true);
      setMissingRecord(false);
      setError('');
      setNotice(
        'Local reminder kept in the archive. Server records and any uncertain outcome are unchanged. Request a fresh source review above for a new plan, or restore this reminder to recover it.',
      );
    } catch {
      setError(
        'Could not confirm a local archive. The original reminder must be recovered before another change.',
      );
    }
  }
  function restoreReminder(archiveKey: string) {
    if (busy || marker || invalid) return;
    try {
      const raw = sessionStorage.getItem(archiveKey);
      if (!raw || !archives.includes(archiveKey))
        throw Error('Missing archive');
      const restored = warmupV2Reminder(JSON.parse(raw), plan.id);
      remember(restored);
      focusTarget.current = 'panel';
      // Move the validated reminder back to the confirmed active pointer. The
      // active copy now preserves every ID, so removing this duplicate loses none.
      try {
        sessionStorage.removeItem(archiveKey);
        if (sessionStorage.getItem(archiveKey) === null)
          setArchives((previous) => previous.filter((k) => k !== archiveKey));
      } catch {
        /* Keep both copies if local removal is unavailable. */
      }
      setArchivePage(0);
      setId(restored.consentId);
      setHistoryId(
        restored.journalId ??
          (restored.request?.kind === 'record' ? restored.request.id : ''),
      );
      setConsent(null);
      setJournal(null);
      setPrepared(null);
      setNotice(
        'Original local reminder restored. Use Recover; nothing was resubmitted.',
      );
    } catch {
      setError(
        'This archived reminder is unreadable. It remains kept locally; no active reminder was replaced.',
      );
    }
  }
  const step = journal?.snapshot.pendingReview
    ? 3
    : journal
      ? 2
      : consent
        ? 1
        : 0;
  return (
    <section className={styles.panel} aria-label="Saved warmup session">
      <div>
        <h6 ref={panelHeading} tabIndex={-1}>
          Prepare your warmup session
        </h6>
        <p>
          Save one plan and recover its progress later. This session does not
          run trades yet.
        </p>
      </div>
      <ol className={styles.steps} aria-label="Warmup preparation steps">
        {[
          'Approve plan',
          'Record history',
          'Review action',
          'Runtime check',
        ].map((name, i) => (
          <li key={name} aria-current={step === i ? 'step' : undefined}>
            {i + 1}. {name}
            {i === 3 ? ' · unavailable' : ''}
          </li>
        ))}
      </ol>
      {!consent && (
        <>
          <label className={styles.field}>
            Finish buffer after the last planned action
            <select
              value={finish}
              disabled={locked}
              onChange={(e) => {
                setFinish(Number(e.target.value));
                setPrepared(null);
                setApproved(false);
              }}
            >
              {[1, 3, 5].map((n) => (
                <option key={n} value={n}>
                  {n} minute{n === 1 ? '' : 's'}
                </option>
              ))}
            </select>
          </label>
          <Button
            disabled={!fresh || locked || !!marker}
            onClick={() => void readTerms()}
          >
            Review session plan
          </Button>
          {!fresh && (
            <p>
              Request and retain a fresh session review above before approving
              new terms. Saved sessions can still be recovered below.
            </p>
          )}
          {prepared && (
            <div className={styles.card}>
              <strong>
                {quantity(prepared.summary.actionCount, 'action')} across{' '}
                {quantity(prepared.summary.walletCount, 'wallet')}
              </strong>
              <p>
                Reviewed maximum:{' '}
                {formatNativeBalance(
                  prepared.summary.maximumNativeSpendLamports,
                  9,
                )}{' '}
                SOL. Finish by{' '}
                {new Date(prepared.terms.sessionExpiresAt).toLocaleString()}.
              </p>
              <p>
                Read policy: one pending action, up to 3 unsigned checks per
                action ({prepared.terms.policy.maxQualifications} total), at
                least 30 seconds apart. Each check expires within 60 seconds and
                never extends this finish time. These limits do not enable
                execution.
              </p>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={approved}
                  disabled={locked || !fresh}
                  onChange={(e) => setApproved(e.target.checked)}
                />
                <span>
                  I approve this exact plan, spending limits, finite read policy
                  and finish deadline. This does not start trades or authorize
                  signing.
                </span>
              </label>
              <Button
                disabled={
                  !approved || locked || !fresh || clock >= prepared.deadline
                }
                onClick={() => void save()}
              >
                Save session approval
              </Button>
            </div>
          )}
        </>
      )}
      {consent && (
        <div className={styles.card}>
          <h6 ref={consentHeading} tabIndex={-1}>
            Plan approved · no trades running
          </h6>
          <p>
            {quantity(consent.summary.actionCount, 'action')} ·{' '}
            {quantity(consent.summary.walletCount, 'wallet')} · reviewed maximum{' '}
            {formatNativeBalance(consent.summary.maximumNativeSpendLamports, 9)}{' '}
            SOL.
          </p>
          <p>
            Revision {consent.summary.planRevision}. Finish by{' '}
            {new Date(consent.terms.sessionExpiresAt).toLocaleString()}.{' '}
            {ended ? 'This session has expired.' : ''}{' '}
            {changed
              ? 'The current plan has a different revision; this is original saved history.'
              : ''}
          </p>
          <p>
            Approval recovery ID: <code>{consent.id}</code>
          </p>
          {!journal && marker?.journalId && (
            <div className={styles.card}>
              <p>
                This approval already has saved history. Recover it to keep its
                original progress and deadline.
              </p>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void recoverHistory()}
              >
                Recover saved history
              </Button>
            </div>
          )}
          {!journal && !marker?.journalId && !marker?.request && (
            <>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={historyChecked}
                  disabled={locked}
                  onChange={(e) => setHistoryChecked(e.target.checked)}
                />
                <span>
                  Record recoverable history for this approval. This will not
                  start activity.
                </span>
              </label>
              <Button
                disabled={locked || !historyChecked || !marker}
                onClick={() => void recordHistory()}
              >
                Record session history
              </Button>
            </>
          )}
        </div>
      )}
      {journal && (
        <div className={styles.card}>
          <h6 ref={journalHeading} tabIndex={-1}>
            Saved progress:{' '}
            {journal.snapshot.stopped
              ? 'stopped'
              : ended
                ? 'expired'
                : journal.snapshot.phase === 'review-required'
                  ? 'ready for review'
                  : journal.snapshot.phase === 'waiting'
                    ? 'waiting for scheduled time'
                    : journal.snapshot.phase}
          </h6>
          <p>
            {journal.snapshot.completedActions} of{' '}
            {journal.snapshot.totalActions} trades completed. No trade has been
            executed by this saved session.
          </p>
          <p>
            History recovery ID: <code>{journal.id}</code>
          </p>
          {!journal.snapshot.pendingReview && consent && (
            <p>
              Next review is due at{' '}
              {new Date(
                JSON.parse(consent.terms.reviewDocument).actions[0].scheduledAt,
              ).toLocaleString()}
              . Before that time it stays disabled.
            </p>
          )}
          {baselineChanged && (
            <p>
              The saved source changed. Stop this review and request a fresh
              plan before new work.
            </p>
          )}
          {journal.snapshot.pendingReview && (
            <p>
              Pending review: {journal.snapshot.pendingReview.side} · cycle{' '}
              {journal.snapshot.pendingReview.cycle} ·{' '}
              <code>{journal.snapshot.pendingReview.wallet}</code>. Pause and
              Stop preserve this action.
            </p>
          )}
          <p>
            Runtime qualification is not connected yet. Saving or reviewing this
            action does not make it signable. The separate quote and simulation
            preview below also grants no signing permission.
          </p>
          {consent && (
            <WalletWarmupSessionV2Attempt
              journal={journal}
              consent={consent}
              disabled={
                locked || sourceDirty || changed || baselineChanged || ended
              }
              invalidated={sourceDirty || changed || baselineChanged || ended}
              now={clock}
            />
          )}
          {!journal.snapshot.stopped && (
            <>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={controlChecked}
                  disabled={locked}
                  onChange={(e) => setControlChecked(e.target.checked)}
                />
                <span>
                  Apply the control I choose against this exact saved state. No
                  signing or transaction.
                </span>
              </label>
              <div className={styles.controls}>
                <Button
                  disabled={
                    locked ||
                    !controlChecked ||
                    ended ||
                    changed ||
                    baselineChanged ||
                    journal.snapshot.paused ||
                    !!journal.snapshot.pendingReview ||
                    clock <
                      Date.parse(
                        JSON.parse(consent!.terms.reviewDocument).actions[0]
                          .scheduledAt,
                      )
                  }
                  onClick={() => void control('begin-review')}
                >
                  Review next action
                </Button>
                <Button
                  variant="outline"
                  disabled={
                    locked ||
                    !controlChecked ||
                    ended ||
                    journal.snapshot.paused
                  }
                  onClick={() => void control('pause')}
                >
                  Pause session review
                </Button>
                <Button
                  variant="outline"
                  disabled={
                    locked ||
                    !controlChecked ||
                    ended ||
                    changed ||
                    baselineChanged ||
                    !journal.snapshot.paused
                  }
                  onClick={() => void control('resume')}
                >
                  Resume session review
                </Button>
                <Button
                  variant="outline"
                  disabled={locked || !controlChecked}
                  onClick={() => void control('stop')}
                >
                  Stop session review
                </Button>
              </div>
              <p>
                Choose the unchecked control approval first. Next action and
                Resume also require an unchanged plan and an unexpired, due
                session. Stop preserves history after expiry.
              </p>
            </>
          )}
        </div>
      )}
      {marker?.request?.kind === 'control' && (
        <div className={styles.card}>
          <strong>A control has an uncertain outcome</strong>
          <p>
            Recover its original ID first. You can separately request Stop
            against that same saved state. Only one control can win that
            version; if the earlier one already won, recover status before
            choosing another control.
          </p>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={stopChecked}
              disabled={busy || invalid || !consent}
              onChange={(e) => setStopChecked(e.target.checked)}
            />
            <span>
              I request Stop against the original pending state. This does not
              cancel a transaction.
            </span>
          </label>
          <Button
            variant="outline"
            disabled={busy || invalid || !consent || !stopChecked}
            onClick={() => void stopPending()}
          >
            {marker.stopRequest
              ? 'Retry same pending Stop request'
              : 'Record Stop for pending state'}
          </Button>
          {!consent && (
            <p>
              Recover the versioned approval below to verify this saved context
              first.
            </p>
          )}
          {marker.stopRequest && (
            <p>
              Pending Stop ID: <code>{marker.stopRequest.id}</code>. A repeat is
              user-requested with this same ID; it never creates another Stop
              event.
            </p>
          )}
        </div>
      )}
      <details
        open={
          pending ||
          invalid ||
          (!!marker && (!consent || (!!marker.journalId && !journal))) ||
          undefined
        }
      >
        <summary>Recover a saved session</summary>
        <div className={styles.card}>
          <p>
            IDs identify saved records, not wallet secrets. Recovery only reads;
            it never resubmits a save or trade.
          </p>
          <label className={styles.field}>
            Session approval ID
            <input
              value={id}
              maxLength={36}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onChange={(e) => {
                setId(e.target.value.trim());
                setConsent(null);
                setJournal(null);
                setApproved(false);
              }}
            />
          </label>
          <Button
            variant="outline"
            disabled={busy || !validId(id)}
            onClick={() => void recoverConsent()}
          >
            Recover saved approval
          </Button>
          {consent && (
            <>
              <label className={styles.field}>
                Session history ID
                <input
                  value={historyId}
                  maxLength={36}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  onChange={(e) => {
                    setHistoryId(e.target.value.trim());
                    setJournal(null);
                    setControlChecked(false);
                  }}
                />
              </label>
              <Button
                variant="outline"
                disabled={busy || !validId(historyId)}
                onClick={() => void recoverHistory()}
              >
                Recover session history
              </Button>
            </>
          )}
          {marker && (
            <p>
              Approval: <code>{marker.consentId}</code>
              {(marker.journalId || marker.request?.kind === 'record') && (
                <>
                  {' '}
                  · History:{' '}
                  <code>
                    {marker.journalId ??
                      (marker.request?.kind === 'record'
                        ? marker.request.id
                        : '')}
                  </code>
                </>
              )}
              {marker.request && (
                <>
                  {' '}
                  · Pending request: <code>{marker.request.id}</code>. Recover
                  this original request before another change.
                </>
              )}
            </p>
          )}
          {invalid && (
            <p>
              The unreadable reminder blocks new writes. Keep any known IDs and
              recover the original session; no local reminder is replaced.
            </p>
          )}
          {(marker || invalid) && (
            <div className={styles.card}>
              <p>
                Keep an archive of this local reminder before starting another
                plan. This does not delete server history, cancel an unknown
                request, or claim that an unconfirmed save failed.
              </p>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={archiveChecked}
                  disabled={busy || !canArchive}
                  onChange={(e) => setArchiveChecked(e.target.checked)}
                />
                <span>
                  I kept my recovery information. Archive this local reminder
                  without cancelling or resubmitting anything.
                </span>
              </label>
              <Button
                variant="outline"
                disabled={busy || !canArchive || !archiveChecked}
                onClick={archiveReminder}
              >
                Keep reminder and reset panel
              </Button>
              {!canArchive && (
                <p>
                  {marker?.request?.kind === 'control'
                    ? 'Resolve the pending control or request Stop against its saved state before archiving.'
                    : marker?.request
                      ? 'Read the original record by GET first. A missing passive save may be archived, but its outcome stays unknown.'
                      : 'Stop the current review before archiving its reminder.'}
                </p>
              )}
            </div>
          )}
          {archives.length > 0 && (
            <div className={styles.card}>
              <strong>Locally archived reminders</strong>
              <p>
                These are kept on this browser only. Restore a reminder, then
                recover its original records. A local archive is not a server
                cancellation.
              </p>
              {archives
                .slice(archivePage * 10, archivePage * 10 + 10)
                .map((archiveKey, index) => (
                  <Button
                    key={archiveKey}
                    variant="outline"
                    disabled={busy || !!marker || invalid}
                    onClick={() => restoreReminder(archiveKey)}
                  >
                    Restore saved reminder {archivePage * 10 + index + 1}
                  </Button>
                ))}
              {archives.length > 10 && (
                <div className={styles.controls}>
                  <Button
                    variant="outline"
                    disabled={busy || archivePage === 0}
                    onClick={() => setArchivePage((p) => p - 1)}
                  >
                    Previous reminders
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || (archivePage + 1) * 10 >= archives.length}
                    onClick={() => setArchivePage((p) => p + 1)}
                  >
                    Next reminders
                  </Button>
                  <p>{archives.length} reminders kept locally.</p>
                </div>
              )}
            </div>
          )}
        </div>
      </details>
      {busy && (
        <output>Confirming this request. No signing or transaction.</output>
      )}
      {hint && (
        <div className={styles.card}>
          <p>
            An original saved record is available: <code>{hint.id}</code>.
            Recovery checks this exact approval and does not replace it.
          </p>
          <Button
            variant="outline"
            disabled={busy || (hint.kind === 'record' && !consent)}
            onClick={() =>
              void (hint.kind === 'consent'
                ? recoverConsent(hint.id)
                : recoverHistory(hint.id))
            }
          >
            {hint.kind === 'consent'
              ? 'Recover existing approval'
              : 'Recover existing session history'}
          </Button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <output>{notice}</output>}
    </section>
  );
}
