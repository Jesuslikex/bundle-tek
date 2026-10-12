'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import type { TrackedWallet } from '@/lib/tracked-wallet';
import type { SignaturePage } from '@/lib/tracked-signatures';
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
  const [page, setPage] = useState<SignaturePage | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [stale, setStale] = useState(false);
  const pending = useRef<AbortController | null>(null);
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
        Public finalized signature records, 25 per page. Inspect a signature to
        decode and save its transaction. This is provider-retained history,
        without trade classification, automatic indexing or wallet creation age.
        Empty or short pages may reflect provider retention. Loaded pages are
        retained here and reopen without RPC. Reloading latest activity replaces
        this retained view.
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
            {new Date(page.observedAt).toLocaleString()} ·{' '}
            {page.signatures.length} loaded
          </p>
          <div className="project-table-wrap">
            <table
              className="project-table"
              aria-label="Public finalized signatures"
            >
              <thead>
                <tr>
                  <th>Signature</th>
                  <th>Finalized slot</th>
                  <th>Status / recorded</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {page.signatures.map((row) => (
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
                      <small>
                        {row.blockTime === null
                          ? 'Time unavailable'
                          : new Date(row.blockTime * 1000).toLocaleString()}
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
