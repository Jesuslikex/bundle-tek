'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import {
  decodeMainnetFundingHistory,
  mainnetFundingRecordLabel,
  type MainnetFundingHistory,
  type MainnetFundingRecord,
} from '@/lib/mainnet-funding-history';

function FundingRecord({ record }: { record: MainnetFundingRecord }) {
  const units = record.asset.kind === 'native' ? 'SOL' : 'tokens';
  return (
    <details>
      <summary>
        Recipient {record.funding.item} · revision {record.funding.revision} ·{' '}
        {mainnetFundingRecordLabel(record)}
      </summary>
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
          Verified finalized slot {record.receipt.slot} · recipient received{' '}
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
        variant="outline"
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
  const pending = useRef<AbortController | null>(null);
  const read = useCallback(
    async (after: string | null) => {
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      setBusy(true);
      setError('');
      try {
        const params = new URLSearchParams({ id });
        if (revision !== null) params.set('revision', String(revision));
        if (after !== null) params.set('cursor', after);
        const response = await fetch('/api/funding/mainnet-history?' + params, {
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(15000),
          ]),
        });
        const body = await response.json();
        if (!response.ok)
          throw new Error(
            body &&
              typeof body === 'object' &&
              'error' in body &&
              typeof body.error === 'string'
              ? body.error
              : 'Mainnet funding history unavailable.',
          );
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
      } catch (failure) {
        if (!controller.signal.aborted && pending.current === controller)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Mainnet funding history unavailable.',
          );
      } finally {
        if (!controller.signal.aborted && pending.current === controller)
          setBusy(false);
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
  const finalized = records.filter((record) => record.receipt !== null).length;
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
          value={revision ?? 'all'}
          onChange={(event) =>
            setRevision(
              event.target.value === 'all' ? null : Number(event.target.value),
            )
          }
        >
          <option value="all">All revisions</option>
          {revisions.map((value) => (
            <option key={value} value={value}>
              Revision {value}
            </option>
          ))}
        </select>
      </label>
      <Button variant="outline" disabled={busy} onClick={() => void read(null)}>
        Reload mainnet funding history
      </Button>
      {error && <p role="alert">{error}</p>}
      {busy && <output>Loading mainnet funding history…</output>}
      {page && (
        <>
          {page.archived && (
            <p>Archived draft. Retained mainnet outcomes remain available.</p>
          )}
          <h5>Recipient progress for revision {page.progress.revision}</h5>
          <p>
            {finalized} verified deliveries · {unresolved} unresolved ·{' '}
            {records.filter((record) => record.failure !== null).length}{' '}
            verified failures ·{' '}
            {records.filter((record) => record.state === 'cancelled').length}{' '}
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
            Latest retained attempt per saved recipient. Allocations without a
            retained attempt are not counted. Earlier attempts remain in the
            transition history.
          </p>
          <ul aria-label="Mainnet recipient progress">
            {records.map((record) => (
              <li key={record.funding.item}>
                <FundingRecord record={record} />
              </li>
            ))}
          </ul>
          {!records.length && (
            <p>No retained mainnet recipient attempts for this revision.</p>
          )}
          <h5>Captured funding transitions</h5>
          <p>
            Transitions are history records, not transfer counts. An earlier
            approval does not inherit a later receipt.
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
              variant="outline"
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
