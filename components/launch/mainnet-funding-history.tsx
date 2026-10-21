'use client';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Button } from '@/components/ui/button';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { readBoundedPanelJson } from '@/lib/read-bounded-panel-json';
import {
  decodeMainnetFundingHistory,
  mainnetFundingRecordLabel,
  mainnetFundingProgressKey,
  type MainnetFundingHistory,
  type MainnetFundingRecord,
} from '@/lib/mainnet-funding-history';

const historyUnavailable =
  'Mainnet funding history is unavailable. Reload history to try again.';
function historyStatus(status: number) {
  if (status === 401) return 'Sign in again before loading funding history.';
  if (status === 403 || status === 404)
    return 'This saved funding history is unavailable to your account. Reopen the saved funding plan.';
  if (status === 429)
    return 'Funding history is rate limited. Wait before reloading.';
  return historyUnavailable;
}

function FundingRecord({ record }: { record: MainnetFundingRecord }) {
  const units = record.asset.kind === 'native' ? 'SOL' : 'tokens';
  return (
    <details>
      <summary className="min-h-11 cursor-pointer py-2">
        Recipient {record.funding.item} · revision {record.funding.revision} ·{' '}
        {record.funding.leg !== undefined && (
          <>Proxy leg {record.funding.leg} · </>
        )}
        {mainnetFundingRecordLabel(record)}
      </summary>
      {record.funding.leg !== undefined && (
        <p>
          This record describes one proxy-route transfer. Its receipt does not
          by itself prove that the final allocation reached its intended wallet.
        </p>
      )}
      <p>
        {record.amount} {units} requested from {record.wallet} to{' '}
        {record.recipient}.
      </p>
      {record.asset.mint && (
        <p>
          Mint {record.asset.mint} · {record.asset.decimals} decimals.
        </p>
      )}
      <p>
        Captured{' '}
        <time dateTime={record.createdAt}>
          {new Date(record.createdAt).toLocaleString()}
        </time>{' '}
        · attempt {record.withdrawalId} · wallet revision{' '}
        {record.walletRevision}.
      </p>
      <p>
        Due {new Date(record.funding.scheduledAt).toLocaleString()} · maximum
        SOL debit {formatNativeBalance(record.maximumDebitLamports, 9)} SOL ·
        fee limit {formatNativeBalance(record.feeLimitLamports, 9)} SOL · source
        reserve {formatNativeBalance(record.reserveLamports, 9)} SOL.
      </p>
      <p>
        Review expires {new Date(record.reviewExpiresAt).toLocaleString()}.
        Expired reviews do not release an unresolved signing or submission
        reservation.
      </p>
      {record.evidenceGap && (
        <output>Evidence gap: {record.evidenceGap}</output>
      )}
      {record.receipt ? (
        <p>
          Verified finalized slot {record.receipt.slot} ·{' '}
          {record.funding.leg === undefined
            ? 'recipient'
            : 'this leg’s destination wallet'}{' '}
          received{' '}
          {formatNativeBalance(
            record.receipt.deliveredRaw,
            record.asset.decimals,
          )}{' '}
          {units} · actual network fee{' '}
          {formatNativeBalance(record.receipt.networkFeeLamports, 9)} SOL
          {record.asset.kind === 'token' && (
            <>
              {' '}
              · account rent{' '}
              {formatNativeBalance(record.receipt.accountRentLamports, 9)} SOL ·
              token fee{' '}
              {formatNativeBalance(
                record.receipt.transferFeeRaw ?? '0',
                record.asset.decimals,
              )}{' '}
              tokens
            </>
          )}
          .
        </p>
      ) : record.failure ? (
        <p>
          Verified finalized failure at slot {record.failure.slot}:{' '}
          {record.failure.label}. Actual network fee{' '}
          {formatNativeBalance(record.failure.networkFeeLamports, 9)} SOL. No
          transfer completed.
        </p>
      ) : (
        <p>
          {record.state === 'failed'
            ? 'Finalized failure details were not retained at this transition. '
            : ''}
          No successful finalized delivery receipt was recorded at this
          transition. Signing and submission records do not prove delivery.
          Recover an unresolved signature before preparing another transfer.
        </p>
      )}
      {record.signature && (
        <a
          href={`https://explorer.solana.com/tx/${encodeURIComponent(record.signature)}`}
          target="_blank"
          rel="noreferrer"
        >
          Inspect mainnet transaction
        </a>
      )}
    </details>
  );
}

export function MainnetFundingHistoryPanel({
  id,
  revision,
  name,
}: {
  id: string;
  revision: number;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section
      className="min-w-0 space-y-3 break-words rounded-md border p-3"
      aria-label="Mainnet funding history"
    >
      <Button
        type="button"
        variant="outline"
        className="h-auto min-h-11 whitespace-normal"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Close' : 'Open'} mainnet funding history
      </Button>
      {open && (
        <FundingHistory
          key={`${id}:${revision}`}
          id={id}
          currentRevision={revision}
          name={name}
        />
      )}
    </section>
  );
}

function FundingHistory({
  id,
  currentRevision,
  name,
}: {
  id: string;
  currentRevision: number;
  name: string;
}) {
  const [revision, setRevision] = useState<number | null>(null),
    [page, setPage] = useState<MainnetFundingHistory | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  const [noticeRole, setNoticeRole] = useState<'status' | 'alert'>('alert');
  const [progressPage, setProgressPage] = useState(0);
  const pageStatus = useRef<HTMLOutputElement>(null);
  const reloadButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const olderButton = useRef<HTMLButtonElement>(null);
  const readInitiator = useRef<Element | null>(null);
  const restoreReadFocus = useRef(false);
  const pending = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    if (busy && readInitiator.current) {
      const initiator = readInitiator.current;
      readInitiator.current = null;
      if (
        document.activeElement === initiator ||
        document.activeElement === document.body
      )
        cancelButton.current?.focus();
    }
    if (!busy && restoreReadFocus.current) {
      restoreReadFocus.current = false;
      if (
        document.activeElement === document.body ||
        document.activeElement === cancelButton.current
      )
        reloadButton.current?.focus();
    }
  }, [busy]);
  const read = useCallback(
    async (after: string | null) => {
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      restoreReadFocus.current = false;
      const active = document.activeElement;
      readInitiator.current =
        active === reloadButton.current || active === olderButton.current
          ? active
          : null;
      setBusy(true);
      setError('');
      setNoticeRole('alert');
      const deadline = setTimeout(() => {
        if (pending.current !== controller) return;
        restoreReadFocus.current =
          document.activeElement === cancelButton.current;
        pending.current = null;
        controller.abort();
        setBusy(false);
        setNoticeRole('status');
        setError('History loading timed out. Reload history to try again.');
      }, 15000);
      const clearDeadline = () => clearTimeout(deadline);
      controller.signal.addEventListener('abort', clearDeadline, {
        once: true,
      });
      try {
        const params = new URLSearchParams({ id });
        if (revision !== null) params.set('revision', String(revision));
        if (after !== null) params.set('cursor', after);
        const response = await fetch('/api/funding/mainnet-history?' + params, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          if (!controller.signal.aborted && pending.current === controller)
            setError(historyStatus(response.status));
          return;
        }
        const body = await readBoundedPanelJson(response, controller.signal);
        const next = decodeMainnetFundingHistory(body, id, revision);
        if (controller.signal.aborted || pending.current !== controller) return;
        setPage((prior) =>
          after && prior
            ? {
                ...next,
                events: [
                  ...prior.events,
                  ...next.events.filter(
                    (event) =>
                      !prior.events.some(
                        (old) => old.sequence === event.sequence,
                      ),
                  ),
                ],
              }
            : next,
        );
      } catch {
        if (!controller.signal.aborted && pending.current === controller)
          setError(historyUnavailable);
      } finally {
        clearDeadline();
        controller.signal.removeEventListener('abort', clearDeadline);
        if (!controller.signal.aborted && pending.current === controller) {
          restoreReadFocus.current =
            document.activeElement === cancelButton.current;
          pending.current = null;
          setBusy(false);
        }
      }
    },
    [id, revision],
  );
  useEffect(() => {
    let disposed = false;
    void Promise.resolve().then(() => {
      if (!disposed) {
        setPage(null);
        void read(null);
      }
    });
    return () => {
      disposed = true;
      pending.current?.abort();
    };
  }, [read]);
  const revisions = [
    ...new Set([
      currentRevision,
      page?.currentRevision ?? currentRevision,
      ...(revision === null ? [] : [revision]),
      ...(page?.events.map((event) => event.funding.revision) ?? []),
    ]),
  ].sort((a, b) => b - a);
  const records = page?.progress.records ?? [];
  const finalized = records.filter(
    (record) => record.receipt !== null && record.funding.leg === undefined,
  ).length;
  const proxyFinalized = records.filter(
    (record) => record.receipt !== null && record.funding.leg !== undefined,
  ).length;
  const progressPages = Math.max(1, Math.ceil(records.length / 25));
  const selectedProgressPage = Math.min(progressPage, progressPages - 1);
  const unresolved = records.filter((record) =>
    ['awaiting_signature', 'signing', 'signed', 'submitted'].includes(
      record.state,
    ),
  ).length;
  return (
    <div className="min-w-0 space-y-3 break-words">
      <h4>Mainnet funding history: {page?.name ?? name}</h4>
      <p>
        Retained saved-recipient attempts and captured transitions across
        funding revisions. This view does not sign, submit or associate native
        SOL funding with a token project.
      </p>
      <label>
        Funding revision{' '}
        <select
          className="min-h-11"
          value={revision ?? 'all'}
          onChange={(event) => {
            pending.current?.abort();
            pending.current = null;
            setPage(null);
            setError('');
            setNoticeRole('alert');
            setBusy(true);
            setProgressPage(0);
            setRevision(
              event.target.value === 'all' ? null : Number(event.target.value),
            );
          }}
        >
          <option value="all">All revisions</option>
          {revisions.map((value) => (
            <option key={value} value={value}>
              Revision {value}
            </option>
          ))}
        </select>
      </label>
      <Button
        ref={reloadButton}
        type="button"
        variant="outline"
        className="h-auto min-h-11 whitespace-normal"
        disabled={busy}
        onClick={() => void read(null)}
      >
        Reload mainnet funding history
      </Button>
      {busy && (
        <Button
          ref={cancelButton}
          type="button"
          variant="outline"
          className="h-auto min-h-11 whitespace-normal"
          onClick={() => {
            const controller = pending.current;
            if (!controller) return;
            restoreReadFocus.current =
              document.activeElement === cancelButton.current;
            pending.current = null;
            controller.abort();
            setBusy(false);
            setNoticeRole('status');
            setError('History loading cancelled. Reload history when ready.');
          }}
        >
          Cancel history loading
        </Button>
      )}
      {error && <p role={noticeRole}>{error}</p>}
      {busy && <output>Loading mainnet funding history…</output>}
      {page && (
        <>
          {(busy || error) && (
            <p>
              Previously loaded history is shown below. Its current state has
              not been refreshed.
            </p>
          )}
          {page.archived && (
            <p>Archived draft. Retained mainnet outcomes remain available.</p>
          )}
          <h5>
            Recipient and route-step progress for revision{' '}
            {page.progress.revision}
          </h5>
          {page.progress.unavailable ? (
            <output>
              Route-step summary is unavailable or inconsistent. Captured
              transitions remain available below. No delivery totals or route
              readiness are inferred.
            </output>
          ) : (
            <>
              <p>
                {finalized} verified deliveries for direct routes ·{' '}
                {proxyFinalized} verified proxy-leg transfers · {unresolved}{' '}
                unresolved steps ·{' '}
                {records.filter((record) => record.failure !== null).length}{' '}
                verified failures ·{' '}
                {
                  records.filter((record) => record.state === 'cancelled')
                    .length
                }{' '}
                cancelled.
              </p>
              {records.some(
                (record) =>
                  (record.state === 'finalized' && !record.receipt) ||
                  (record.state === 'failed' && !record.failure),
              ) && (
                <p>
                  Recorded outcomes without verified evidence:{' '}
                  {
                    records.filter(
                      (record) =>
                        (record.state === 'finalized' && !record.receipt) ||
                        (record.state === 'failed' && !record.failure),
                    ).length
                  }
                  . They are excluded from verified delivery and failure totals.
                </p>
              )}
              <p>
                Latest retained attempt per saved recipient or proxy leg.
                Proxy-leg transfers are not counted as final allocation
                deliveries. Allocations without a retained attempt are not
                counted. Earlier attempts remain in the transition history. This
                is latest-attempt history, not an execution ledger or permission
                to repeat a transfer. Loading older transitions also refreshes
                this summary.
              </p>
              <output
                ref={pageStatus}
                tabIndex={-1}
                aria-label="Mainnet route progress page"
              >
                Showing{' '}
                {Math.min(
                  25,
                  Math.max(0, records.length - selectedProgressPage * 25),
                )}{' '}
                of {records.length} retained route steps, page{' '}
                {selectedProgressPage + 1} of {progressPages}. Counts cover all
                retained steps, not only this page.
              </output>
              <ul aria-label="Mainnet recipient progress">
                {records
                  .slice(
                    selectedProgressPage * 25,
                    (selectedProgressPage + 1) * 25,
                  )
                  .map((record) => (
                    <li key={mainnetFundingProgressKey(record)}>
                      <FundingRecord record={record} />
                    </li>
                  ))}
              </ul>
              {progressPages > 1 && (
                <nav aria-label="Mainnet route progress pages">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto min-h-11 whitespace-normal"
                    disabled={selectedProgressPage === 0}
                    onClick={() => {
                      setProgressPage(selectedProgressPage - 1);
                      pageStatus.current?.focus();
                    }}
                  >
                    Previous route steps
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto min-h-11 whitespace-normal"
                    disabled={selectedProgressPage === progressPages - 1}
                    onClick={() => {
                      setProgressPage(selectedProgressPage + 1);
                      pageStatus.current?.focus();
                    }}
                  >
                    Next route steps
                  </Button>
                </nav>
              )}
              {!records.length && (
                <p>No retained mainnet recipient attempts for this revision.</p>
              )}
            </>
          )}
          <h5>Captured funding transitions</h5>
          <p>
            Transitions are history records, not transfer counts. An earlier
            approval does not inherit a later receipt. Loading older entries
            retains previously loaded transition pages. Use Reload mainnet
            funding history to refresh and return to the newest transitions.
          </p>
          <ol aria-label="Mainnet funding transitions">
            {page.events.map((event) => (
              <li key={event.sequence}>
                <FundingRecord record={event} />
              </li>
            ))}
          </ol>
          {!page.events.length && (
            <p>No retained mainnet funding transitions in this filter.</p>
          )}
          {page.nextCursor && (
            <Button
              ref={olderButton}
              type="button"
              variant="outline"
              className="h-auto min-h-11 whitespace-normal"
              disabled={busy}
              onClick={() => void read(page.nextCursor)}
            >
              Load older mainnet transitions
            </Button>
          )}
        </>
      )}
    </div>
  );
}
