'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import type { TrackedWallet } from '@/lib/tracked-wallet';
import type { SignaturePage } from '@/lib/tracked-signatures';
import {
  trackedHistoryView,
  trackedHistoryTimeLabel,
  trackedHistoryRelativeLabel,
  TRACKED_HISTORY_FILTERS,
  type TrackedHistoryFilters,
} from '@/lib/tracked-history-view';
import viewStyles from './tracked-history-view.module.css';
import { useTrackedHistoryClock } from './use-tracked-history-clock';
export function TrackedSignatureBrowser({
  wallet,
  onOpen,
}: {
  wallet: TrackedWallet;
  onOpen: (signature: string, saved: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Public signature history">
      <Button variant="outline" onClick={() => setOpen((v) => !v)}>
        {open ? 'Close public activity' : 'Browse public activity'}
      </Button>
      {open && (
        <Browser
          key={`${wallet.network}:${wallet.address}:${wallet.updatedAt}`}
          wallet={wallet}
          onOpen={onOpen}
        />
      )}
    </section>
  );
}
function Browser({
  wallet,
  onOpen,
}: {
  wallet: TrackedWallet;
  onOpen: (signature: string, saved: boolean) => void;
}) {
  const displayTime = useTrackedHistoryClock();
  const [page, setPage] = useState<SignaturePage | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [stale, setStale] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const [filters, setFilters] = useState<TrackedHistoryFilters>({
    ...TRACKED_HISTORY_FILTERS,
  });
  const [displayPage, setDisplayPage] = useState(0);
  const view = trackedHistoryView(
    page?.signatures ?? [],
    filters,
    displayPage,
    (row) => (row.blockTime === null ? null : row.blockTime * 1000),
  );
  useEffect(() => {
    const c = new AbortController();
    pending.current = c;
    const query = new URLSearchParams({
      address: wallet.address,
      network: wallet.network,
      expectedUpdatedAt: wallet.updatedAt,
    });
    void fetch(`/api/tracker/signatures/saved?${query}`, {
      cache: 'no-store',
      signal: c.signal,
    })
      .then(async (response) => {
        const data = (await response.json()) as {
          page: SignaturePage | null;
          stale: boolean;
          executionAllowed: boolean;
          error?: string;
        };
        if (
          !response.ok ||
          data.executionAllowed !== false ||
          (data.page &&
            (data.page.address !== wallet.address ||
              data.page.network !== wallet.network ||
              !Array.isArray(data.page.signatures)))
        )
          throw new Error(data.error || 'Retained activity response mismatch.');
        if (!c.signal.aborted) {
          setPage(data.page);
          setStale(data.stale);
          setError('');
        }
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Retained activity unavailable.',
          );
      })
      .finally(() => {
        if (!c.signal.aborted) setBusy(false);
      });
    return () => pending.current?.abort();
  }, [wallet.address, wallet.network, wallet.updatedAt]);
  async function read(older: boolean) {
    if (busy) return;
    pending.current?.abort();
    const c = new AbortController();
    pending.current = c;
    setBusy(true);
    try {
      const query = new URLSearchParams({
        address: wallet.address,
        network: wallet.network,
        expectedUpdatedAt: wallet.updatedAt,
        ...(older && page?.nextCursor ? { cursor: page.nextCursor } : {}),
      });
      const response = await fetch(`/api/tracker/signatures/saved?${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        cache: 'no-store',
        signal: c.signal,
      });
      const data = (await response.json()) as {
        page?: SignaturePage;
        executionAllowed: boolean;
        error?: string;
      };
      if (
        !response.ok ||
        !data.page ||
        data.page.address !== wallet.address ||
        data.page.network !== wallet.network ||
        data.executionAllowed !== false ||
        !Array.isArray(data.page.signatures)
      )
        throw new Error(data.error || 'Activity response mismatch.');
      if (
        data.page.signatures.length > 250 ||
        (older && page && data.page.anchor !== page.anchor)
      )
        throw new Error(
          'Retained activity context mismatch. Reload latest activity.',
        );
      if (!c.signal.aborted && pending.current === c) {
        const incoming = data.page;
        setPage(incoming);
        if (!older) setDisplayPage(0);
        setStale(false);
        setError('');
      }
    } catch (e) {
      if (!c.signal.aborted && pending.current === c)
        setError(e instanceof Error ? e.message : 'Activity unavailable.');
    } finally {
      if (!c.signal.aborted && pending.current === c) setBusy(false);
    }
  }
  return (
    <>
      <p>
        Public finalized signature records, displayed 25 at a time. Inspect a
        signature to decode and save its transaction. This is provider-retained
        history, without trade classification, automatic indexing or wallet
        creation age. Empty or short pages may reflect provider retention.
        Loaded pages are retained here and reopen without RPC. Reloading latest
        activity replaces this retained view.
      </p>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => void read(false)}
      >
        Load latest public activity
      </Button>
      {stale && (
        <p>
          The tracked wallet changed since this snapshot. Retained records
          remain readable; reload latest activity before continuing older pages.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {busy && <output>Loading public activity…</output>}
      {page && (
        <>
          <p>
            {page.source} · anchor slot {page.anchor} · last read{' '}
            {trackedHistoryTimeLabel(Date.parse(page.observedAt))} ·{' '}
            {page.signatures.length} loaded
          </p>
          <TrackedHistoryControls
            kind="Public activity"
            filters={filters}
            onChange={(next) => {
              setFilters(next);
              setDisplayPage(0);
            }}
          />
          <Button
            variant="outline"
            onClick={() => displayTime.setRelative(!displayTime.relative)}
          >
            {displayTime.relative
              ? 'Show full UTC public block time'
              : 'Show relative public block time'}
          </Button>
          <p>
            Relative values describe public block timestamps, not wallet age.
            Exact UTC is available in each time tooltip and the full-time view.
          </p>
          <p className={viewStyles.note}>
            Dates filter public block time in UTC, not the time this page was
            saved. Records with unavailable block time stay visible unless a
            date bound is set. Search is case-sensitive and matches part of a
            signature. Filters apply only to the {page.signatures.length} loaded
            records.
          </p>
          {!view.valid && (
            <p role="alert">
              Choose valid UTC dates with the end date on or after the start
              date.
            </p>
          )}
          {view.valid && view.matching === 0 && (
            <p>
              {page.signatures.length
                ? 'No loaded public records match these filters.'
                : 'No public records were retained in this view.'}
            </p>
          )}
          <div className="project-table-wrap">
            <table
              className="project-table"
              aria-label="Public finalized signatures"
            >
              <thead>
                <tr>
                  <th>Signature</th>
                  <th>Finalized slot</th>
                  <th>
                    Status / block time{' '}
                    {displayTime.relative ? '(relative)' : '(UTC)'}
                  </th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {view.rows.map((row) => (
                  <tr key={row.signature}>
                    <td>
                      <code title={row.signature}>
                        {row.signature.slice(0, 8)}…{row.signature.slice(-8)}
                      </code>
                    </td>
                    <td>{row.slot}</td>
                    <td>
                      <strong>
                        {row.failed ? 'Failed' : 'No recorded error'}
                      </strong>
                      <small
                        title={trackedHistoryTimeLabel(
                          row.blockTime === null ? null : row.blockTime * 1000,
                        )}
                      >
                        {displayTime.relative
                          ? trackedHistoryRelativeLabel(
                              row.blockTime === null
                                ? null
                                : row.blockTime * 1000,
                              displayTime.now,
                            )
                          : trackedHistoryTimeLabel(
                              row.blockTime === null
                                ? null
                                : row.blockTime * 1000,
                            )}
                      </small>
                    </td>
                    <td>
                      <Button
                        variant="outline"
                        onClick={() => onOpen(row.signature, false)}
                      >
                        Inspect public transaction
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TrackedHistoryPagination
            kind="Public activity"
            view={view}
            onPage={setDisplayPage}
          />
          {page.nextCursor ? (
            <Button
              variant="outline"
              disabled={busy || stale || page.signatures.length >= 250}
              onClick={() => void read(true)}
            >
              Load older public activity
            </Button>
          ) : (
            <p>No more records returned by this provider.</p>
          )}
          {page.signatures.length >= 250 && (
            <p>
              250-record browsing limit reached. Reload latest activity to start
              a new view.
            </p>
          )}
        </>
      )}
    </>
  );
}

export function TrackedHistoryControls({
  kind,
  filters,
  onChange,
}: {
  kind: 'Public activity' | 'Saved observations';
  filters: TrackedHistoryFilters;
  onChange: (next: TrackedHistoryFilters) => void;
}) {
  return (
    <fieldset className={viewStyles.controls}>
      <legend>{kind} filters</legend>
      <div className={viewStyles.filters}>
        <label>
          {kind} signature search
          <input
            type="search"
            maxLength={88}
            autoCapitalize="none"
            spellCheck={false}
            value={filters.search}
            onChange={(e) => onChange({ ...filters, search: e.target.value })}
          />
        </label>
        <label>
          {kind} status
          <select
            value={filters.status}
            onChange={(e) =>
              onChange({
                ...filters,
                status: e.target.value as TrackedHistoryFilters['status'],
              })
            }
          >
            <option value="all">All statuses</option>
            <option value="failed">Failed</option>
            <option value="no-error">No recorded error</option>
          </select>
        </label>
        <label>
          {kind} from date (UTC)
          <input
            type="date"
            value={filters.from}
            onChange={(e) => onChange({ ...filters, from: e.target.value })}
          />
        </label>
        <label>
          {kind} through date (UTC)
          <input
            type="date"
            value={filters.to}
            onChange={(e) => onChange({ ...filters, to: e.target.value })}
          />
        </label>
        <label>
          {kind} time order
          <select
            value={filters.order}
            onChange={(e) =>
              onChange({
                ...filters,
                order: e.target.value as TrackedHistoryFilters['order'],
              })
            }
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </label>
      </div>
      <Button
        variant="outline"
        onClick={() => onChange({ ...TRACKED_HISTORY_FILTERS })}
      >
        Clear {kind.toLowerCase()} filters
      </Button>
    </fieldset>
  );
}
export function TrackedHistoryPagination({
  kind,
  view,
  onPage,
}: {
  kind: 'Public activity' | 'Saved observations';
  view: {
    valid: boolean;
    matching: number;
    loaded: number;
    page: number;
    pageCount: number;
  };
  onPage: (next: number) => void;
}) {
  return (
    <fieldset className={viewStyles.pages}>
      <legend>{kind} display pages</legend>
      <output>
        {view.valid
          ? `${view.matching} matching of ${view.loaded} loaded records. Display page ${view.page + 1} of ${view.pageCount}.`
          : 'Invalid date range. Loaded records are retained.'}
      </output>
      <Button
        variant="outline"
        disabled={!view.valid || view.page === 0}
        onClick={() => onPage(view.page - 1)}
      >
        Previous {kind.toLowerCase()} display page
      </Button>
      <Button
        variant="outline"
        disabled={!view.valid || view.page >= view.pageCount - 1}
        onClick={() => onPage(view.page + 1)}
      >
        Next {kind.toLowerCase()} display page
      </Button>
    </fieldset>
  );
}
