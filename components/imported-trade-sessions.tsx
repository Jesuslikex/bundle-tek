'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { SessionPreparationJobs } from './session-preparation-jobs';
import { TradeSessionSizing } from './trade-session-sizing';
import { TradeSessionSellSizing } from './trade-session-sell-sizing';
import { ImportedApprovalHistory } from './imported-approval-history';
import type { ImportedSwapReceipt } from '@/lib/imported-approval-history';
import type { SessionApprovalSelection } from '@/lib/trade-session-approval';
import { useTradeSessionStatus } from './use-trade-session-status';
import {
  decodeTradeSessionStatus,
  requireCurrentSessionStatus,
} from '@/lib/trade-session-status';
import { TradeSessionTimeline } from './trade-session-timeline';
import { Button } from './ui/button';
import { Input } from './ui/input';
import {
  decodeTradeSession,
  validatedTradeSessionControls,
  type TradeSessionControl,
  sessionEntryNotBefore,
  validatedTradeSessionActivity,
  tradeSessionTerms,
  type TradeSession,
} from '@/lib/imported-trade-session';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import { walletFolderIds } from '@/lib/wallet-workspace';
import type { WorkspaceWallet, WalletFolder } from '@/lib/wallet-workspace';
import { ImportedSwapPreparation } from './imported-swap-preparation';
import { JitoAtomicBundle } from './jito-atomic-bundle';
import { SessionEntryOutcomesPanel } from './session-entry-outcomes';
import { DcaTradeSession } from './dca-trade-session';
type Activity = {
  sessionId: string;
  entry: number;
  intentId: string;
  state: string;
  signature: string | null;
  receiptId: string | null;
};
export function ImportedTradeSessions({
  project,
  wallets,
  folders,
  locked,
  onReviewBuy,
}: {
  project: ImportedTokenProject;
  wallets: WorkspaceWallet[];
  folders: WalletFolder[];
  locked: boolean;
  onReviewBuy?: (receipt: ImportedSwapReceipt) => void;
}) {
  const [side, setSide] = useState<'Buy' | 'Sell'>('Buy'),
    [selected, setSelected] = useState(''),
    [folder, setFolder] = useState(''),
    [entries, setEntries] = useState<
      { wallet: WorkspaceWallet; amount: string }[]
    >([]),
    [sessions, setSessions] = useState<TradeSession[]>([]),
    [activity, setActivity] = useState<Activity[]>([]),
    [controls, setControls] = useState<TradeSessionControl[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [preparing, setPreparing] = useState<{
      session: TradeSession;
      entry: number;
      wallet: WorkspaceWallet;
      jobId?: string;
    } | null>(null);
  const [recovery, setRecovery] = useState<SessionApprovalSelection | null>(
    null,
  );
  const startInputId = useId(),
    spacingInputId = useId();
  const [scheduled, setScheduled] = useState(false),
    [startAt, setStartAt] = useState(''),
    [spacing, setSpacing] = useState('30'),
    [now, setNow] = useState(() => Date.now());
  const needsClock = sessions.some(
    (s) =>
      s.state === 'active' &&
      ((s.terms.schedule &&
        Date.parse(sessionEntryNotBefore(s.terms, s.terms.entries.length)!) >
          now) ||
        (s.terms.endsAt && Date.parse(s.terms.endsAt) > now)),
  );
  useEffect(() => {
    if (!needsClock) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [needsClock]);
  const [showTimeline, setShowTimeline] = useState(false),
    [historyRevision, setHistoryRevision] = useState(0);
  const pending = useRef<AbortController | null>(null),
    retry = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const liveStatus = useTradeSessionStatus(project.id, busy, (value) => {
    const next = decodeTradeSessionStatus(value, project.id);
    requireCurrentSessionStatus(next, sessions, controls, activity);
    const changed =
      JSON.stringify(next) !== JSON.stringify({ sessions, controls, activity });
    if (!changed) return;
    setPreparing(null);
    setSessions(next.sessions);
    setControls(next.controls);
    setActivity(next.activity);
    setHistoryRevision((v) => v + 1);
  });
  const roster = wallets.filter((w) => w.chain === 'Solana' && !w.archived);
  const invalidateSizedSell = useCallback((wallet: string, amount: string) => {
    setEntries((old) =>
      old.map((entry) =>
        entry.wallet.address === wallet && entry.amount === amount
          ? { ...entry, amount: '' }
          : entry,
      ),
    );
  }, []);
  function add(items: WorkspaceWallet[]) {
    const unique = items.filter(
      (w) => !entries.some((e) => e.wallet.address === w.address),
    );
    if (entries.length + unique.length > 25) {
      setError(
        'A session supports at most 25 wallets. Choose a smaller group.',
      );
      return;
    }
    setEntries((old) => [
      ...old,
      ...unique.map((wallet) => ({ wallet, amount: '' })),
    ]);
    setError('');
  }
  async function request(body?: unknown) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const response = await fetch(
      body
        ? '/api/imported-projects/trade-sessions'
        : `/api/imported-projects/trade-sessions?projectId=${encodeURIComponent(project.id)}`,
      {
        method: body ? 'POST' : 'GET',
        cache: 'no-store',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(30000),
        ]),
      },
    );
    const data = (await response.json()) as {
      error?: string;
      projectId: string;
      sessions: unknown[];
      session: unknown;
      activity: Activity[];
      control: unknown;
      controls: unknown;
      executionAllowed: boolean;
    };
    if (!response.ok) throw new Error(data.error || 'Session unavailable.');
    if (controller.signal.aborted) throw new Error('Session view changed.');
    return data;
  }
  async function load() {
    if (busy) return;
    setBusy(true);
    setError('');
    setPreparing(null);
    try {
      const data = await request();
      if (
        data.projectId !== project.id ||
        data.executionAllowed !== false ||
        !Array.isArray(data.sessions) ||
        data.sessions.length > 100 ||
        !Array.isArray(data.activity) ||
        data.activity.length > 200
      )
        throw new Error('Session history context differs.');
      const values = data.sessions.map(decodeTradeSession);
      if (values.some((s) => s.terms.projectId !== project.id))
        throw new Error('Session project differs.');
      const captures = validatedTradeSessionControls(data.controls, values),
        activity = validatedTradeSessionActivity(data.activity, values);
      setSessions(values);
      setControls(captures);
      setActivity(activity);
      setHistoryRevision((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'History unavailable.');
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (busy || locked) return;
    setBusy(true);
    setError('');
    try {
      if (scheduled && (!startAt || !Number.isFinite(Date.parse(startAt))))
        throw new Error('Choose a valid start in your local timezone.');
      const input = {
        action: 'create',
        projectId: project.id,
        projectRevision: project.revision,
        side,
        ...(scheduled
          ? {
              schedule: {
                startAt: new Date(startAt).toISOString(),
                spacingSeconds: /^(0|[1-9]\d{0,4})$/.test(spacing)
                  ? Number(spacing)
                  : NaN,
              },
            }
          : {}),
        entries: entries.map((e) => ({
          wallet: e.wallet.address,
          walletRevision: e.wallet.revision,
          amount: e.amount,
        })),
      };
      const terms = tradeSessionTerms(input, project.document.token),
        key = JSON.stringify(input);
      if (retry.current?.key !== key)
        retry.current = { key, id: crypto.randomUUID() };
      const data = await request({ ...input, id: retry.current.id });
      const s = decodeTradeSession(data.session);
      if (
        s.id !== retry.current.id ||
        JSON.stringify(s.terms) !== JSON.stringify(terms) ||
        data.executionAllowed !== false
      )
        throw new Error('Saved session differs. Reload history.');
      const [control] = validatedTradeSessionControls([data.control], [s]);
      setControls((old) => [
        control,
        ...old.filter((v) => v.sessionId !== s.id),
      ]);
      setSessions((old) => [s, ...old.filter((v) => v.id !== s.id)]);
      setHistoryRevision((v) => v + 1);
      retry.current = null;
      setPreparing(null);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Save unavailable. Retry the same terms to recover the same session.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function cancel(s: TradeSession) {
    setBusy(true);
    setError('');
    setPreparing(null);
    try {
      await request({
        action: 'cancel',
        id: s.id,
        projectId: project.id,
        revision: s.revision,
      });
      setHistoryRevision((v) => v + 1);
      setSessions((old) =>
        old.map((v) =>
          v.id === s.id
            ? {
                ...v,
                state: 'cancelled',
                revision: 2,
                updatedAt: new Date().toISOString(),
              }
            : v,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cancellation unavailable.');
    } finally {
      setBusy(false);
    }
  }

  async function changeControl(s: TradeSession) {
    const old = controls.find((c) => c.sessionId === s.id);
    if (!old || busy) return;
    const action = old.state === 'ready' ? 'pause' : 'resume';
    setBusy(true);
    setError('');
    setPreparing(null);
    try {
      const data = await request({
        action,
        id: s.id,
        projectId: project.id,
        revision: old.revision,
      });
      const [control] = validatedTradeSessionControls([data.control], [s]);
      if (
        data.executionAllowed !== false ||
        control.state !== (action === 'pause' ? 'paused' : 'ready') ||
        control.revision !== old.revision + 1
      )
        throw new Error('Session control changed. Reload history.');
      setControls((prior) =>
        prior.map((c) => (c.sessionId === s.id ? control : c)),
      );
      setHistoryRevision((v) => v + 1);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Session control unavailable. Reload to recover the saved state.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="conditional-sell-orders min-w-0 max-w-full space-y-3 break-words"
      aria-label="Multi-wallet trade sessions"
    >
      <h4>Multi-wallet trade sessions</h4>
      <DcaTradeSession
        key={`${project.id}:${project.revision}:${project.archived}`}
        project={project}
        wallets={wallets}
        locked={locked || busy}
        onBusyChange={setBusy}
        onSaved={(session, control) => {
          setSessions((old) => [
            session,
            ...old.filter((s) => s.id !== session.id),
          ]);
          setControls((old) => [
            control,
            ...old.filter((c) => c.sessionId !== session.id),
          ]);
          setHistoryRevision((value) => value + 1);
        }}
      />
      <p>
        Save exact Buy or Sell amounts for up to 25 wallets. Each entry uses
        fresh balances, a reviewed packet, your signature and a separate submit
        action. No background execution or shared signing approval.
      </p>
      <label>
        Session timing
        <select
          value={scheduled ? 'scheduled' : 'immediate'}
          disabled={busy || locked}
          onChange={(e) => setScheduled(e.target.value === 'scheduled')}
        >
          <option value="immediate">Available immediately</option>
          <option value="scheduled">Scheduled start and wallet spacing</option>
        </select>
      </label>
      {scheduled && (
        <div className="space-y-2">
          <label htmlFor={startInputId}>
            Start in your local timezone
            <Input
              id={startInputId}
              type="datetime-local"
              value={startAt}
              disabled={busy || locked}
              onChange={(e) => setStartAt(e.target.value)}
              onInput={(e) => setStartAt(e.currentTarget.value)}
            />
          </label>
          <label htmlFor={spacingInputId}>
            Seconds between wallet entries
            <Input
              id={spacingInputId}
              inputMode="numeric"
              value={spacing}
              disabled={busy || locked}
              onChange={(e) => setSpacing(e.target.value)}
            />
          </label>
          <p>
            Start is stored in UTC. Each entry becomes eligible at start plus
            its position times this spacing. Preparation and submission happen
            only after the server confirms it is due. Signatures are requested
            individually; execution time depends on your approval.
          </p>
        </div>
      )}
      <label>
        Session side
        <select
          value={side}
          disabled={busy || locked}
          onChange={(e) => {
            setSide(e.target.value as 'Buy' | 'Sell');
            setEntries((old) => old.map((v) => ({ ...v, amount: '' })));
          }}
        >
          <option value="Buy">Buy with SOL</option>
          <option value="Sell">Sell project tokens</option>
        </select>
      </label>
      <label>
        Add wallet
        <select
          value={selected}
          disabled={busy || locked}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">Choose wallet</option>
          {roster.map((w) => (
            <option key={w.address} value={w.address}>
              {w.label || w.address}
            </option>
          ))}
        </select>
      </label>
      <Button
        variant="outline"
        disabled={busy || locked || !selected}
        onClick={() => add(roster.filter((w) => w.address === selected))}
      >
        Add wallet to session
      </Button>
      <label>
        Wallet folder
        <select
          value={folder}
          disabled={busy || locked}
          onChange={(e) => setFolder(e.target.value)}
        >
          <option value="">Choose folder</option>
          {folders
            .filter((f) => !f.archived)
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
        </select>
      </label>
      <Button
        variant="outline"
        disabled={busy || locked || !folder}
        onClick={() =>
          add(roster.filter((w) => walletFolderIds(w).includes(folder)))
        }
      >
        Add folder wallets
      </Button>
      {side === 'Sell' && (
        <TradeSessionSellSizing
          key={`${project.id}:${project.revision}`}
          project={project}
          roster={roster}
          selected={entries.map((e) => e.wallet)}
          onInvalidate={invalidateSizedSell}
          disabled={busy || locked}
          onApply={(amounts) =>
            setEntries((old) =>
              old.map((entry, index) => ({ ...entry, amount: amounts[index] })),
            )
          }
        />
      )}
      <TradeSessionSizing
        key={`${project.id}:${project.revision}:${side}:${project.document.token.decimals}`}
        amounts={entries.map((e) => e.amount)}
        decimals={side === 'Buy' ? 9 : project.document.token.decimals}
        currency={side === 'Buy' ? 'SOL' : project.document.token.symbol}
        disabled={busy || locked}
        onApply={(amounts) =>
          setEntries((old) =>
            old.map((entry, index) => ({ ...entry, amount: amounts[index] })),
          )
        }
      />
      {entries.map((e, i) => (
        <div key={e.wallet.address}>
          <p>
            {i + 1}. {e.wallet.label || e.wallet.address}
          </p>
          <label>
            Amount for {e.wallet.address} (
            {side === 'Buy' ? 'SOL' : project.document.token.symbol})
            <Input
              value={e.amount}
              disabled={busy || locked}
              inputMode="decimal"
              onChange={(event) =>
                setEntries((old) =>
                  old.map((v) =>
                    v.wallet.address === e.wallet.address
                      ? { ...v, amount: event.target.value }
                      : v,
                  ),
                )
              }
            />
          </label>
          <Button
            variant="outline"
            disabled={busy || locked}
            onClick={() =>
              setEntries((old) =>
                old.filter((v) => v.wallet.address !== e.wallet.address),
              )
            }
          >
            Remove wallet {i + 1}
          </Button>
        </div>
      ))}
      <Button
        disabled={busy || locked || project.archived || entries.length === 0}
        onClick={() => void save()}
      >
        Save exact session
      </Button>{' '}
      <Button variant="outline" disabled={busy} onClick={() => void load()}>
        Reload saved trade sessions
      </Button>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => {
          setShowTimeline((v) => !v);
        }}
      >
        {showTimeline ? 'Hide session timeline' : 'View session timeline'}
      </Button>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() =>
          liveStatus.state.status === 'off'
            ? liveStatus.start()
            : liveStatus.stop()
        }
      >
        {liveStatus.state.status === 'off'
          ? 'Start live session status'
          : 'Stop live session status'}
      </Button>
      <p>
        Live status reads saved sessions every five seconds while this tab is
        visible and online. It resumes after reconnecting and retries failed
        reads up to every 30 seconds. A changed status closes the current
        preparation review. It does not prepare, sign or submit trades. Closing
        this panel stops refreshes.
      </p>
      <output aria-live="polite">
        Live session status: {liveStatus.state.status}. {liveStatus.state.reads}{' '}
        successful refreshes. {liveStatus.state.reason}
        {liveStatus.state.retryInMs !== null &&
          ` Retry in ${liveStatus.state.retryInMs / 1000} seconds.`}
      </output>
      {liveStatus.readAt !== null && (
        <p>Saved status read: {new Date(liveStatus.readAt).toLocaleString()}</p>
      )}
      {liveStatus.error && (
        <p role="alert">{liveStatus.error} Retained results remain visible.</p>
      )}
      {showTimeline && (
        <TradeSessionTimeline
          projectId={project.id}
          revision={historyRevision}
        />
      )}
      {error && <p role="alert">{error}</p>}
      {sessions.map((s) => (
        <article key={s.id} className="space-y-2 rounded-md border p-3">
          {s.terms.strategy !== 'DCA' && (
            <JitoAtomicBundle
              projectId={project.id}
              session={s}
              locked={
                locked ||
                controls.find((c) => c.sessionId === s.id)?.state !== 'ready'
              }
            />
          )}
          <h5>
            {s.terms.side} session · {s.state}
          </h5>
          <p>
            Session {s.id}. {new Set(s.terms.entries.map((e) => e.wallet)).size}{' '}
            wallets; {s.terms.entries.length} entries; total input{' '}
            {s.terms.totalRaw} atomic units. Fees and wallet reserves are
            additional.
          </p>
          <SessionEntryOutcomesPanel
            session={s}
            revision={historyRevision}
            recoveryDisabled={busy}
            sellDisabled={busy || locked || project.archived}
            onRecover={(entry, intentId) => {
              setPreparing(null);
              setRecovery({ entry, intentId, session: s });
            }}
            onReviewBuy={onReviewBuy}
          />
          <p>
            Session control:{' '}
            {controls.find((c) => c.sessionId === s.id)?.state || 'unavailable'}
            ; revision{' '}
            {controls.find((c) => c.sessionId === s.id)?.revision ??
              'unavailable'}
            . Pause stops new preparation, review and submission. Existing
            signatures remain recoverable; transactions already submitted can
            still settle.
          </p>
          <Button
            variant="outline"
            disabled={
              busy ||
              s.state !== 'active' ||
              !controls.some((c) => c.sessionId === s.id)
            }
            onClick={() => void changeControl(s)}
          >
            {controls.find((c) => c.sessionId === s.id)?.state === 'paused'
              ? 'Resume session'
              : 'Pause session'}
          </Button>
          {s.terms.schedule && (
            <p>
              {s.terms.endsAt && `DCA end time (UTC): ${s.terms.endsAt}. `}
              {s.terms.strategy === 'DCA' &&
                `DCA ${s.terms.side}: ${s.terms.entries.length} cycles for one wallet. `}
              Scheduled start (UTC): {s.terms.schedule.startAt}. Spacing:{' '}
              {s.terms.schedule.spacingSeconds} seconds. Saving does not start
              background execution.
            </p>
          )}
          {s.terms.entries.map((e) => {
            const notBefore = sessionEntryNotBefore(s.terms, e.entry),
              waiting = notBefore !== undefined && Date.parse(notBefore) > now,
              ended =
                s.terms.endsAt !== undefined &&
                Date.parse(s.terms.endsAt) <= now;
            const state = activity.find(
                (a) => a.sessionId === s.id && a.entry === e.entry,
              ),
              wallet = roster.find(
                (w) =>
                  w.address === e.wallet && w.revision === e.walletRevision,
              ),
              blocked =
                state &&
                [
                  'awaiting_signature',
                  'signed',
                  'submitted',
                  'finalized',
                ].includes(state.state);
            return (
              <div key={e.entry}>
                <p>
                  {s.terms.strategy === 'DCA' ? 'Cycle' : 'Entry'} {e.entry}:{' '}
                  {e.wallet} · {e.amount}{' '}
                  {s.terms.side === 'Buy' ? 'SOL' : `tokens (${s.terms.mint})`}{' '}
                  · {state?.state || 'Not approved'}
                  {state && (
                    <>
                      . Approval {state.intentId}
                      {state.signature && <>. Signature {state.signature}</>}
                      {state.receiptId && <>. Receipt {state.receiptId}</>}
                    </>
                  )}
                </p>
                {(project.archived ||
                  s.terms.projectRevision !== project.revision ||
                  !wallet) && (
                  <p>
                    Project or wallet context changed. Create a fresh session to
                    prepare this entry; retained approvals remain recoverable.
                  </p>
                )}
                {state && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setPreparing(null);
                      setRecovery({
                        intentId: state.intentId,
                        session: s,
                        entry: e.entry,
                      });
                    }}
                  >
                    Review saved approval for entry {e.entry}
                  </Button>
                )}
                {notBefore && (
                  <p>
                    Entry start (UTC): {notBefore}.{' '}
                    {ended
                      ? 'DCA end time reached. New preparation and submission are closed; retained approvals remain recoverable.'
                      : waiting
                        ? `Waiting ${Math.ceil((Date.parse(notBefore) - now) / 1000)} seconds before review.`
                        : 'Due for review; the server checks timing before preparation and submission.'}
                  </p>
                )}
                <Button
                  variant="outline"
                  disabled={
                    busy ||
                    locked ||
                    project.archived ||
                    s.state !== 'active' ||
                    s.terms.projectRevision !== project.revision ||
                    !wallet ||
                    !!blocked ||
                    controls.find((c) => c.sessionId === s.id)?.state !==
                      'ready' ||
                    waiting ||
                    ended
                  }
                  onClick={() =>
                    setPreparing({
                      session: s,
                      entry: e.entry,
                      wallet: wallet!,
                    })
                  }
                >
                  Prepare session entry {e.entry}
                </Button>
              </div>
            );
          })}
          <SessionPreparationJobs
            session={s}
            disabled={
              busy ||
              locked ||
              project.archived ||
              s.state !== 'active' ||
              s.terms.projectRevision !== project.revision ||
              (s.terms.endsAt !== undefined &&
                Date.parse(s.terms.endsAt) <= now) ||
              controls.find((c) => c.sessionId === s.id)?.state !== 'ready'
            }
            onReview={(job) => {
              const entry = s.terms.entries.find((e) => e.entry === job.entry),
                wallet = roster.find(
                  (w) =>
                    w.address === entry?.wallet &&
                    w.revision === entry.walletRevision,
                );
              if (!entry || !wallet) {
                setError('Session wallet changed. Reload current wallets.');
                return;
              }
              setRecovery(null);
              setPreparing({
                session: s,
                entry: job.entry,
                wallet,
                jobId: job.id,
              });
            }}
          />
          <Button
            variant="outline"
            disabled={
              busy ||
              s.state !== 'active' ||
              activity.some(
                (a) =>
                  a.sessionId === s.id &&
                  ['awaiting_signature', 'signed', 'submitted'].includes(
                    a.state,
                  ),
              )
            }
            onClick={() => void cancel(s)}
          >
            Cancel remaining session entries
          </Button>
        </article>
      ))}
      <p>
        Reload sessions to refresh approvals and receipts. Use project approval
        recovery for signed or pending entries. Session amounts cannot be edited
        after saving.
      </p>
      {recovery && (
        <section
          aria-label="Selected session approval"
          className="min-w-0 max-w-full space-y-2 break-words"
        >
          <Button variant="outline" onClick={() => setRecovery(null)}>
            Close session entry recovery
          </Button>
          <ImportedApprovalHistory
            key={recovery.intentId}
            project={project}
            selection={recovery}
            onReviewBuy={onReviewBuy}
            submissionBlocked={
              busy ||
              locked ||
              sessions.find((s) => s.id === recovery.session.id)?.state !==
                'active' ||
              controls.find((c) => c.sessionId === recovery.session.id)
                ?.state !== 'ready'
            }
          />
        </section>
      )}
      {preparing && (
        <ImportedSwapPreparation
          key={`${preparing.session.id}:${preparing.entry}:${preparing.jobId ?? 'fresh'}`}
          project={project}
          preparationJobId={preparing.jobId}
          wallet={preparing.wallet}
          side={preparing.session.terms.side}
          amount={
            preparing.session.terms.entries.find(
              (e) => e.entry === preparing.entry,
            )!.amount
          }
          locked={
            busy ||
            locked ||
            (preparing.session.terms.endsAt !== undefined &&
              Date.parse(preparing.session.terms.endsAt) <= now)
          }
          sessionNotBefore={sessionEntryNotBefore(
            preparing.session.terms,
            preparing.entry,
          )}
          session={{
            sessionId: preparing.session.id,
            revision: preparing.session.revision,
            entry: preparing.entry,
          }}
        />
      )}
    </section>
  );
}
