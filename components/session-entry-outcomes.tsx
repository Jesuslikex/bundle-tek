'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import {
  decodeSessionEntryOutcomes,
  type SessionEntryOutcome,
  type SessionEntryOutcomes as OutcomeData,
} from '@/lib/session-entry-outcomes';
import {
  decodeTradeSession,
  sessionEntryNotBefore,
  type TradeSession,
} from '@/lib/imported-trade-session';
import { sessionJobLabels } from '@/lib/session-preparation-job-events';
import type { ImportedSwapReceipt } from '@/lib/imported-approval-history';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import { UUID } from '@/lib/wallet-operation';
import { SessionOutcomeSummary } from './session-outcome-summary';

type Props = {
  session: TradeSession;
  revision: number;
  onRecover: (entry: number, intentId: string) => void;
  onReviewBuy?: (receipt: ImportedSwapReceipt) => void;
  recoveryDisabled?: boolean;
  sellDisabled?: boolean;
};
type ReaderProps = Omit<Partial<Props>, 'revision'> & {
  projectId: string;
  sessionId?: string;
  eventId?: string;
  revision: number;
};
const buttonClass = 'h-auto max-w-full whitespace-normal break-words py-2';
const approvalLabels = {
  awaiting_signature: 'Awaiting signature',
  signed: 'Signature captured',
  submitted: 'Submission recorded',
  finalized: 'Finalized approval recorded',
  failed: 'Failed approval recorded',
  cancelled: 'Cancelled approval recorded',
};
const preparationErrors: Record<string, string> = {
  'balance-unavailable':
    'Insufficient or unsupported balance evidence. The record does not identify a specific fee shortfall.',
  'rate-limited': 'Preparation read was rate limited.',
  'context-changed': 'Preparation context changed.',
  'service-unavailable': 'Preparation service was unavailable.',
  'lease-expired': 'Preparation lease expired.',
};

export function SessionEntryOutcomesPanel(props: Props) {
  const [open, setOpen] = useState(false);
  // Remount before rendering evidence or callbacks against different saved terms.
  const scope = JSON.stringify([
    props.session.id,
    props.session.createdAt,
    props.session.terms,
  ]);
  return (
    <section
      aria-label="Saved session wallet outcomes"
      className="min-w-0 max-w-full space-y-2 break-words"
    >
      <Button
        variant="outline"
        className={buttonClass}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Close' : 'Open'} session wallet outcomes
      </Button>
      {open && (
        <OutcomeSnapshot
          key={scope}
          {...props}
          projectId={props.session.terms.projectId}
          sessionId={props.session.id}
        />
      )}
    </section>
  );
}

export function SessionEntryOutcomes({
  project,
  eventId,
  sessionId,
  onReviewBuy,
}: {
  project: ImportedTokenProject;
  eventId?: string;
  sessionId?: string;
  onReviewBuy?: (receipt: ImportedSwapReceipt) => void;
}) {
  const [open, setOpen] = useState(false);
  const validReference =
    Number(eventId !== undefined) + Number(sessionId !== undefined) === 1 &&
    (eventId !== undefined
      ? typeof eventId === 'string' && /^[a-f0-9]{32}$/.test(eventId)
      : typeof sessionId === 'string' && UUID.test(sessionId));
  const scope = JSON.stringify([project.id, eventId, sessionId]);
  return (
    <section
      aria-label="Current retained session outcomes"
      className="min-w-0 max-w-full space-y-2 break-words"
    >
      <Button
        variant="outline"
        className={buttonClass}
        aria-expanded={open}
        disabled={!validReference}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Close' : 'Open'} current session outcomes
      </Button>
      {!validReference && (
        <p role="alert">
          Choose exactly one valid session or saved session event reference.
        </p>
      )}
      {validReference && open && (
        <>
          <p>
            Current retained outcomes for the referenced session are sampled
            when opened. The original historical row remains its captured event.
          </p>
          <OutcomeSnapshot
            key={scope}
            projectId={project.id}
            eventId={eventId}
            sessionId={sessionId}
            revision={project.revision}
            onReviewBuy={onReviewBuy}
            sellDisabled={project.archived}
          />
        </>
      )}
    </section>
  );
}

function OutcomeSnapshot({
  session,
  projectId,
  sessionId,
  eventId,
  revision,
  onRecover,
  onReviewBuy,
  recoveryDisabled = false,
  sellDisabled = false,
}: ReaderProps) {
  // The parent key binds these immutable terms. Status and callback changes do
  // not cause a read; revision changes and explicit reloads do.
  const [reference] = useState(() => ({
    session,
    projectId,
    sessionId,
    eventId,
  }));
  const [snapshot, setSnapshot] = useState<OutcomeData | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const pending = useRef<{
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const cancelRead = useCallback(() => {
    if (!pending.current) return;
    clearTimeout(pending.current.timer);
    pending.current.controller.abort();
    pending.current = null;
  }, []);
  const read = useCallback(async () => {
    cancelRead();
    const controller = new AbortController();
    const request = {
      controller,
      timer: setTimeout(() => {
        if (pending.current?.controller !== controller) return;
        controller.abort();
        pending.current = null;
        setBusy(false);
        setError(
          'Session outcome read timed out. Reload to refresh retained evidence.',
        );
      }, 10000),
    };
    pending.current = request;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `/api/imported-projects/session-entry-outcomes?${new URLSearchParams({
          projectId: reference.projectId,
          ...(reference.eventId !== undefined
            ? { eventId: reference.eventId }
            : { sessionId: reference.sessionId! }),
        })}`,
        { method: 'GET', cache: 'no-store', signal: controller.signal },
      );
      const value: unknown = await response.json();
      if (controller.signal.aborted || pending.current !== request) return;
      if (!response.ok)
        throw new Error(
          'Session outcomes unavailable. Reload to refresh retained evidence.',
        );
      const page = value as { projectId?: unknown; session?: unknown };
      const expected = reference.session ?? decodeTradeSession(page?.session);
      if (
        page.projectId !== reference.projectId ||
        expected.terms.projectId !== reference.projectId ||
        (reference.sessionId !== undefined &&
          expected.id !== reference.sessionId)
      )
        throw new Error('Session outcome project or reference differs.');
      setSnapshot(
        decodeSessionEntryOutcomes(value, expected, reference.eventId),
      );
    } catch (cause) {
      if (!controller.signal.aborted && pending.current === request)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Session outcomes unavailable.',
        );
    } finally {
      clearTimeout(request.timer);
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    }
  }, [cancelRead, reference]);
  useEffect(() => {
    let current = true;
    void Promise.resolve().then(() => {
      if (current) return read();
    });
    return () => {
      current = false;
      cancelRead();
    };
  }, [read, cancelRead, revision]);
  const expected = reference.session ?? snapshot?.session;

  return (
    <div className="min-w-0 space-y-3 break-words" aria-busy={busy}>
      <p>
        Every saved wallet entry is listed below. This is the latest retained
        snapshot, separate from historical timeline events. Reading it does not
        prepare, sign or submit a trade. Missing records do not establish that
        no attempt occurred.
      </p>
      {expected && (
        <p>
          Saved {expected.terms.side} input:{' '}
          {formatNativeBalance(
            expected.terms.totalRaw,
            expected.terms.side === 'Buy' ? 9 : expected.terms.decimals,
          )}{' '}
          {expected.terms.side === 'Buy' ? 'SOL' : 'tokens'}. Exact total:{' '}
          {expected.terms.totalRaw}{' '}
          {expected.terms.side === 'Buy' ? 'lamports' : 'token atomic units'}.
        </p>
      )}
      <Button
        variant="outline"
        className={buttonClass}
        disabled={busy}
        onClick={() => void read()}
      >
        {busy
          ? 'Loading session wallet outcomes…'
          : 'Reload session wallet outcomes'}
      </Button>
      {snapshot && (
        <>
          <p>
            Retained snapshot sampled (UTC):{' '}
            <time dateTime={snapshot.sampledAt}>{snapshot.sampledAt}</time>.{' '}
            Saved session state: {snapshot.session.state}.
          </p>
          <p>
            {snapshot.missingSources.length
              ? `Incomplete source coverage. Unavailable sources: ${snapshot.missingSources.join(', ')}. Outcomes in those sources remain unknown.`
              : 'Preparation, approval and receipt sources were available for this snapshot. Absence of a retained record does not prove no attempt.'}
          </p>
          <SessionOutcomeSummary snapshot={snapshot} />
        </>
      )}
      {error && (
        <p role="alert">
          {error}
          {snapshot
            ? ' The previous snapshot remains visible at its sampled time.'
            : ' Retained outcomes are unknown.'}
        </p>
      )}
      {expected ? (
        <ol className="space-y-3">
          {expected.terms.entries.map((entry, index) => (
            <li key={entry.entry}>
              <WalletOutcome
                entry={entry}
                session={expected}
                outcome={snapshot?.entries[index]}
                missingSources={snapshot?.missingSources ?? null}
                onRecover={onRecover}
                onReviewBuy={onReviewBuy}
                recoveryDisabled={busy || recoveryDisabled}
                sellDisabled={busy || sellDisabled}
              />
            </li>
          ))}
        </ol>
      ) : (
        <p>
          The referenced saved session and its wallet outcomes have not loaded.
          Outcomes are unknown.
        </p>
      )}
      <p>
        Unsigned job times are captured event times and do not prove the exact
        start of an attempt. Captured approval states require separate finalized
        receipt evidence. Current wallet balances do not reconstruct these
        outcomes.
      </p>
    </div>
  );
}

function WalletOutcome({
  entry,
  session,
  outcome,
  missingSources,
  onRecover,
  onReviewBuy,
  recoveryDisabled,
  sellDisabled,
}: Pick<
  Props,
  'session' | 'onReviewBuy' | 'recoveryDisabled' | 'sellDisabled'
> & {
  onRecover?: Props['onRecover'];
  entry: TradeSession['terms']['entries'][number];
  outcome?: SessionEntryOutcome;
  missingSources: OutcomeData['missingSources'] | null;
}) {
  const job = outcome?.preparation;
  const approval = outcome?.approval;
  const receipt =
    outcome?.receiptEvidence === 'matching' ? outcome.receipt : null;
  const scheduledAt = sessionEntryNotBefore(session.terms, entry.entry);
  return (
    <article
      aria-label={`Saved wallet entry ${entry.entry}`}
      className="min-w-0 space-y-2 rounded-md border p-3 break-words"
    >
      <h6>Entry {entry.entry}</h6>
      <p className="warmup-address">
        Wallet: {entry.wallet}. Saved wallet revision {entry.walletRevision}.
      </p>
      <p>
        Saved {session.terms.side} input: {entry.amount}{' '}
        {session.terms.side === 'Buy'
          ? 'SOL'
          : `tokens (${session.terms.mint})`}
        . Exact input: {entry.unitsRaw}{' '}
        {session.terms.side === 'Buy' ? 'lamports' : 'token atomic units'}.
      </p>
      {scheduledAt && (
        <p>
          Scheduled entry start (UTC):{' '}
          <time dateTime={scheduledAt}>{scheduledAt}</time>.
        </p>
      )}
      {!outcome ? (
        <p>
          Retained preparation, approval and receipt evidence has not loaded.
          Outcomes are unknown.
        </p>
      ) : (
        <>
          {job ? (
            <div>
              <p>
                Latest retained unsigned job:{' '}
                {sessionJobLabels[job.document.state]} ({job.document.state}).
                Recorded attempts: {job.document.attempts}/3.
              </p>
              <p>
                Latest job event captured (UTC):{' '}
                <time dateTime={job.createdAt}>{job.createdAt}</time>.
              </p>
              {job.document.error && (
                <p>
                  Captured preparation error: {job.document.error}.{' '}
                  {preparationErrors[job.document.error]}
                </p>
              )}
              {job.document.preparationId && (
                <p>
                  Unsigned preparation: {job.document.preparationId}.
                  Preparation alone does not establish a submitted trade.
                </p>
              )}
            </div>
          ) : (
            <p>
              {missingSources?.includes('preparation')
                ? 'Preparation source unavailable; prior attempts are unknown.'
                : 'No retained unsigned job event in this snapshot; prior attempts are unknown.'}
            </p>
          )}
          {approval ? (
            <div>
              <p>
                Latest captured approval: {approvalLabels[approval.state]} (
                {approval.state}).
              </p>
              <p>
                Approval observed (UTC):{' '}
                <time dateTime={approval.observedAt}>
                  {approval.observedAt}
                </time>
                .
              </p>
              <p>
                Approval: {approval.intentId}. Preparation:{' '}
                {approval.preparationId}.
              </p>
              {approval.signature && (
                <p className="warmup-address">
                  Captured signature: {approval.signature}.
                </p>
              )}
              {approval.state === 'failed' && (
                <p>
                  This failed approval state does not establish a finalized
                  transaction failure. Finalized failure evidence is not
                  included in this snapshot.
                </p>
              )}
              {['signed', 'submitted'].includes(approval.state) && (
                <p>
                  The captured signature or submission does not establish a
                  finalized outcome.
                </p>
              )}
              {onRecover && (
                <Button
                  variant="outline"
                  className={buttonClass}
                  disabled={recoveryDisabled}
                  onClick={() => {
                    if (!recoveryDisabled)
                      onRecover(entry.entry, approval.intentId);
                  }}
                >
                  Review saved approval for entry {entry.entry}
                </Button>
              )}
            </div>
          ) : (
            <p>
              {missingSources?.includes('approval')
                ? 'Approval source unavailable; prior approvals are unknown.'
                : 'No retained approval record in this snapshot; prior attempts are unknown.'}
            </p>
          )}
          {receipt ? (
            <div>
              <p>
                Matching finalized {receipt.document.side} receipt:{' '}
                {formatNativeBalance(
                  receipt.document.tokenUnitsRaw,
                  receipt.document.decimals,
                )}{' '}
                tokens {receipt.document.side === 'Buy' ? 'acquired' : 'sold'}.
                Exact token amount: {receipt.document.tokenUnitsRaw} token
                atomic units.
              </p>
              <p>
                Receipt observed (UTC):{' '}
                <time dateTime={receipt.document.observedAt}>
                  {receipt.document.observedAt}
                </time>
                . Source: {receipt.document.source}.
              </p>
              <p>
                Receipt: {receipt.id}. Mainnet finalized signature verified.
              </p>
              {receipt.document.side === 'Buy' && onReviewBuy && (
                <Button
                  variant="outline"
                  className={buttonClass}
                  disabled={sellDisabled}
                  onClick={() => {
                    if (!sellDisabled) onReviewBuy(receipt);
                  }}
                >
                  Review sell of acquired tokens for entry {entry.entry}
                </Button>
              )}
            </div>
          ) : outcome.receiptEvidence === 'contradictory' ? (
            <p>
              Receipt evidence is contradictory. A matching finalized receipt
              could not be established; finalized amounts are withheld.
            </p>
          ) : outcome.receiptEvidence === 'unavailable' ? (
            <p>
              Matching finalized receipt unavailable. The recorded finalized
              approval alone does not establish receipt amounts.
            </p>
          ) : (
            <p>
              {missingSources?.includes('receipts')
                ? 'Receipt source unavailable. Finalized outcome evidence is unknown.'
                : 'No matching finalized receipt in this snapshot. This does not establish that no transaction occurred.'}
            </p>
          )}
        </>
      )}
    </article>
  );
}
