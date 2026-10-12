'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import type { TrackedWallet } from '@/lib/tracked-wallet';
import type { EvmDiscovery } from '@/lib/evm-transaction-discovery';
import { EvmDiscoveryBatch } from './evm-discovery-batch';
type Saved = {
  discovery: EvmDiscovery | null;
  capturedUpdatedAt: string | null;
  currentUpdatedAt: string;
  stale: boolean;
  executionAllowed: boolean;
  error?: string;
};
export function EvmTransactionDiscovery({
  wallet,
  onSelect,
}: {
  wallet: TrackedWallet;
  onSelect: (hash: string) => void;
}) {
  const [saved, setSaved] = useState<Saved | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  const [includeTokenEvents, setIncludeTokenEvents] = useState(false);
  const [batchActive, setBatchActive] = useState(false);
  const adoptScan = useCallback(
    (discovery: EvmDiscovery) => {
      setSaved({
        discovery,
        currentUpdatedAt: wallet.updatedAt,
        capturedUpdatedAt: wallet.updatedAt,
        stale: false,
        executionAllowed: false,
      });
      setError('');
    },
    [wallet.updatedAt],
  );
  const pending = useRef<AbortController | null>(null);
  const validate = useCallback(
    (data: Saved) => {
      if (
        data.executionAllowed !== false ||
        data.currentUpdatedAt !== wallet.updatedAt ||
        (data.discovery &&
          (data.discovery.address !== wallet.address ||
            data.discovery.chain !== wallet.network ||
            !Array.isArray(data.discovery.candidates) ||
            data.discovery.candidates.length > 100))
      )
        throw new Error('Discovery context mismatch.');
      return data;
    },
    [wallet.address, wallet.network, wallet.updatedAt],
  );
  useEffect(() => {
    const controller = new AbortController();
    pending.current = controller;
    void fetch(
      `/api/tracker/evm-discovery?${new URLSearchParams({ address: wallet.address, network: wallet.network, expectedUpdatedAt: wallet.updatedAt })}`,
      { signal: controller.signal, cache: 'no-store' },
    )
      .then(async (r) => {
        const data = (await r.json()) as Saved;
        if (!r.ok)
          throw new Error(data.error || 'Saved discovery unavailable.');
        if (!controller.signal.aborted) {
          setSaved(validate(data));
          setIncludeTokenEvents(data.discovery?.includesTokenEvents === true);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Saved discovery unavailable.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => pending.current?.abort();
  }, [wallet.address, wallet.network, wallet.updatedAt, validate]);
  async function scan(action: 'latest' | 'older' = 'latest') {
    if (busy || batchActive || wallet.archived) return;
    const controller = new AbortController();
    pending.current?.abort();
    pending.current = controller;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/tracker/evm-discovery', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          address: wallet.address,
          network: wallet.network,
          expectedUpdatedAt: wallet.updatedAt,
          action,
          ...(action === 'latest' ? { includeTokenEvents } : {}),
        }),
      });
      const data = (await response.json()) as Saved;
      if (!response.ok)
        throw new Error(
          data.error || 'Discovery unavailable. Previous scan retained.',
        );
      if (!controller.signal.aborted) setSaved(validate(data));
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Discovery unavailable.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label="Recent EVM transaction discovery">
      <h4>Find recent transactions</h4>
      <label>
        <input
          type="checkbox"
          checked={includeTokenEvents}
          disabled={busy || batchActive || wallet.archived}
          onChange={(e) => setIncludeTokenEvents(e.target.checked)}
        />{' '}
        Include ERC-20 transfer events in a new scan
      </label>
      <p>
        Scan the latest ten blocks for direct transactions and, when selected,
        ERC-20 transfer events involving this address. This replaces the saved
        discovery window. Select a hash below, then inspect it to read its
        receipt and token events. Opening this section only reads the saved
        scan.
      </p>
      <p>
        Token event scans read complete block receipt sets. Providers may not
        support this method or may exceed response bounds. Older pages keep the
        saved scan&apos;s event mode; changing this choice takes effect on the
        next latest scan.
      </p>
      <div className="wallet-roster-toolbar">
        <Button
          type="button"
          disabled={busy || batchActive || wallet.archived}
          onClick={() => void scan()}
        >
          {busy ? 'Reading discovery…' : 'Scan latest ten blocks'}
        </Button>
        <Button
          type="button"
          disabled={
            busy ||
            batchActive ||
            wallet.archived ||
            !saved?.discovery?.fromParentHash ||
            !saved.discovery.fromBlockHash ||
            saved.discovery.fromBlock === '0' ||
            (saved.discovery.pages?.length ?? 1) >= 20 ||
            saved.discovery.candidates.length >= 100
          }
          onClick={() => void scan('older')}
        >
          Load older blocks
        </Button>
      </div>
      <EvmDiscoveryBatch
        key={`${wallet.network}:${wallet.address}:${wallet.updatedAt}:${wallet.archived}`}
        wallet={wallet}
        disabled={busy || !saved?.discovery || saved.stale}
        onScan={adoptScan}
        onActive={setBatchActive}
      />
      <p>
        Older reads append the preceding ten blocks to the saved scan, up to 20
        pages and 100 transaction matches. A latest scan starts a new window.
        Older scans must still connect to the saved canonical branch.
      </p>
      {error && <p role="alert">{error}</p>}
      {saved?.discovery && !saved.discovery.fromParentHash && (
        <p>
          This saved scan predates continuation anchors. Run a latest scan to
          enable older pages.
        </p>
      )}
      {wallet.archived && (
        <p>
          Archived address. Saved discovery remains readable; restore to scan
          again.
        </p>
      )}
      {saved?.discovery ? (
        <>
          <p>
            Blocks {saved.discovery.fromBlock}–{saved.discovery.toBlock} ·{' '}
            {saved.discovery.blocksScanned} blocks ·{' '}
            {saved.discovery.transactionsScanned} transactions checked ·{' '}
            {saved.discovery.candidates.length}{' '}
            {saved.discovery.includesTokenEvents
              ? 'transaction matches'
              : 'direct matches'}{' '}
            · {saved.discovery.matchingEventCount ?? 0} matching token events.
          </p>
          <p>
            Observed {new Date(saved.discovery.observedAt).toLocaleString()} ·{' '}
            {saved.discovery.source}. Anchor {saved.discovery.blockHash}.
          </p>
          {saved.stale && (
            <p>
              Wallet metadata changed since this scan. These are historical
              observations.
            </p>
          )}
          <p>{saved.discovery.coverage}</p>
          <details>
            <summary>Discovery read history</summary>
            <ul>
              {(saved.discovery.pages ?? [saved.discovery]).map((page) => (
                <li key={page.toBlock}>
                  Blocks {page.fromBlock} to {page.toBlock} · read{' '}
                  {new Date(page.observedAt).toLocaleString()} ·{' '}
                  {page.transactionsScanned} transactions checked · anchor{' '}
                  {page.blockHash}
                </li>
              ))}
            </ul>
          </details>
          <div className="tracker-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time / block</th>
                  <th>Direction</th>
                  <th>Declared value</th>
                  <th>Transaction hash</th>
                </tr>
              </thead>
              <tbody>
                {saved.discovery.candidates.map((candidate) => (
                  <tr key={candidate.hash}>
                    <td>
                      {new Date(candidate.blockTime).toLocaleString()}
                      <br />
                      {candidate.blockNumber} · index{' '}
                      {candidate.transactionIndex}
                    </td>
                    <td>
                      {candidate.direction}
                      {Boolean(candidate.transferEvents?.length) && (
                        <details>
                          <summary>
                            {candidate.transferEvents!.length} token events
                          </summary>
                          {candidate.transferEvents!.map((event) => (
                            <p key={event.logIndex}>
                              {event.direction} · log {event.logIndex}
                              <br />
                              <code>{event.contract}</code>
                              <br />
                              Raw token units: {event.raw}
                            </p>
                          ))}
                        </details>
                      )}
                    </td>
                    <td>
                      {candidate.value} {saved.discovery!.currency}
                      <br />
                      Raw: {candidate.valueRaw}
                      {candidate.direction === 'Token events' && (
                        <>
                          <br />
                          Enclosing transaction value, not this wallet&apos;s
                          change.
                        </>
                      )}
                    </td>
                    <td>
                      <code>{candidate.hash}</code>
                      <br />
                      <Button
                        type="button"
                        disabled={wallet.archived || busy || batchActive}
                        onClick={() => onSelect(candidate.hash)}
                      >
                        Use transaction hash
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!saved.discovery.candidates.length && (
            <p>
              No matches in this scan&apos;s coverage. This does not prove
              inactivity.
            </p>
          )}
        </>
      ) : (
        !busy && <p>No discovery window saved.</p>
      )}
    </section>
  );
}
