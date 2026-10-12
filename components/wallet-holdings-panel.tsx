'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { HoldingsSnapshot, TokenHolding } from '@/lib/wallet-holdings';
import { HoldingsTokenDetails } from './holdings-token-details';

export function WalletHoldingsPanel({
  address,
  label,
  active,
  onClose,
  trackerUpdatedAt,
  onWithdraw,
}: {
  address: string;
  label: string;
  active: boolean;
  onClose: () => void;
  trackerUpdatedAt?: string;
  onWithdraw?: (holding: TokenHolding) => void;
}) {
  const [snapshot, setSnapshot] = useState<HoldingsSnapshot | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [query, setQuery] = useState('');
  const [showZero, setShowZero] = useState(false);
  const [selectedToken, setSelectedToken] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const endpoint = trackerUpdatedAt
    ? '/api/tracker/holdings'
    : '/api/wallet-workspace/holdings';
  useEffect(() => {
    heading.current?.focus();
    const request = new AbortController();
    controller.current = request;
    void fetch(
      endpoint +
        '?' +
        new URLSearchParams({
          address,
          ...(trackerUpdatedAt ? { network: 'mainnet' } : {}),
        }),
      { cache: 'no-store', signal: request.signal },
    )
      .then(async (response) => {
        const data = (await response.json()) as {
          snapshot: HoldingsSnapshot | null;
          error?: string;
          stale?: boolean;
          currentUpdatedAt?: string;
        };
        if (!response.ok)
          throw new Error(data.error || 'Holdings unavailable.');
        if (
          data.snapshot &&
          (data.snapshot.address !== address ||
            data.snapshot.chain !== 'Solana')
        )
          throw new Error('Holdings do not match the selected wallet.');
        if (!request.signal.aborted) {
          setSnapshot(data.snapshot);
          setStale(
            Boolean(
              trackerUpdatedAt &&
              (data.stale || data.currentUpdatedAt !== trackerUpdatedAt),
            ),
          );
        }
      })
      .catch((e) => {
        if (!request.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!request.signal.aborted) setBusy(false);
      });
    return () => {
      controller.current?.abort();
    };
  }, [address, endpoint, trackerUpdatedAt]);
  async function refresh() {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          trackerUpdatedAt
            ? {
                network: 'mainnet',
                address,
                expectedUpdatedAt: trackerUpdatedAt,
              }
            : { chain: 'Solana', address },
        ),
        signal: request.signal,
      });
      const data = (await response.json()) as {
        snapshot: HoldingsSnapshot | null;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || 'Holdings unavailable.');
      if (
        !data.snapshot ||
        data.snapshot.address !== address ||
        data.snapshot.chain !== 'Solana'
      )
        throw new Error('Holdings do not match the selected wallet.');
      if (!request.signal.aborted) {
        setSnapshot(data.snapshot);
        setStale(false);
      }
    } catch (e) {
      if (!request.signal.aborted)
        setError(e instanceof Error ? e.message : 'Holdings unavailable.');
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  }
  const holdings =
    snapshot?.holdings.filter(
      (h) => (showZero || BigInt(h.raw) > 0n) && h.mint.includes(query.trim()),
    ) ?? [];
  const inspectedHolding = snapshot?.holdings.find(
    (h) => `${h.program}/${h.mint}` === selectedToken,
  );
  return (
    <section className="wallet-holdings-panel" aria-label="Token holdings">
      <div className="wallet-roster-toolbar">
        <div>
          <h2 ref={heading} tabIndex={-1}>
            Token holdings · {label || 'Unnamed wallet'}
          </h2>
          <p>
            <code>{address}</code>
          </p>
        </div>
        <Button variant="outline" onClick={onClose}>
          Close holdings
        </Button>
      </div>
      <p className="source-note">
        Solana token accounts from both token programs. Balances are observed
        units; frozen accounts and token extensions can restrict transfers.
        Prices and spendable balances are not available.
      </p>
      <div className="wallet-roster-toolbar">
        <Input
          aria-label="Search token mint"
          placeholder="Search mint address…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedToken(null);
          }}
        />
        <label>
          <input
            type="checkbox"
            checked={showZero}
            onChange={(e) => setShowZero(e.target.checked)}
          />{' '}
          Show zero balances
        </label>
        <Button disabled={busy || !active} onClick={() => void refresh()}>
          {busy ? 'Loading holdings…' : 'Refresh token holdings'}
        </Button>
      </div>
      {error && (
        <p role="alert" className="draft-error">
          {error}
        </p>
      )}
      {!active && (
        <p className="source-note">
          Refresh is available for active wallets. Retained observations remain
          available.
        </p>
      )}
      {stale && (
        <p className="source-note">
          The tracked wallet changed since this observation. Reload the tracker
          and refresh holdings to capture its current version.
        </p>
      )}
      {snapshot ? (
        <>
          <p className="source-note">
            Observed {new Date(snapshot.observedAt).toLocaleString()} ·{' '}
            {snapshot.source} · confirmed slots {snapshot.minSlot} to{' '}
            {snapshot.maxSlot} · {snapshot.accountCount} accounts ·{' '}
            {snapshot.holdings.length} mints
          </p>
          {snapshot.source === 'docs-demo.solana-mainnet.quiknode.pro' && (
            <p className="source-note">
              Public demo data provider. Availability is limited; a dedicated
              provider is required before production release.
            </p>
          )}
          {inspectedHolding && (
            <HoldingsTokenDetails
              key={`${snapshot.observedAt}/${inspectedHolding.program}/${inspectedHolding.mint}`}
              holding={inspectedHolding}
              onClose={() => setSelectedToken(null)}
            />
          )}
          <div className="wallet-roster-table">
            <table className="project-table">
              <thead>
                <tr>
                  <th>Mint address</th>
                  <th>Observed balance</th>
                  <th>Token accounts</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((h) => (
                  <tr key={h.program + '/' + h.mint}>
                    <td>
                      <code>{h.mint}</code>
                      <small>
                        {h.program ===
                        'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
                          ? 'Token-2022'
                          : 'SPL Token'}
                      </small>
                      <Button
                        variant="outline"
                        onClick={() =>
                          setSelectedToken(`${h.program}/${h.mint}`)
                        }
                      >
                        Inspect token
                      </Button>
                      {onWithdraw &&
                        h.mint !==
                          'So11111111111111111111111111111111111111112' && (
                          <Button
                            variant="outline"
                            disabled={
                              !active ||
                              stale ||
                              busy ||
                              h.raw === '0' ||
                              h.accounts.some(
                                (a) =>
                                  a.frozen ||
                                  (a.extensions &&
                                    (!a.extensionTypes ||
                                      a.extensionTypes.some(
                                        (n) =>
                                          ![
                                            'immutableOwner',
                                            'transferFeeAmount',
                                          ].includes(n),
                                      ))),
                              )
                            }
                            onClick={() => onWithdraw(h)}
                          >
                            Review token withdrawal
                          </Button>
                        )}
                    </td>
                    <td>
                      <strong>{h.amount}</strong>
                      <small>{h.decimals} decimals</small>
                    </td>
                    <td>
                      {h.accounts.map((a) => (
                        <details key={a.address}>
                          <summary>
                            {a.address.slice(0, 6)}…{a.address.slice(-4)}
                            {a.frozen ? ' · frozen' : ''}
                          </summary>
                          <code>{a.address}</code>
                          <small>Raw units: {a.raw}</small>
                        </details>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!holdings.length && (
            <p>
              {snapshot.accountCount === 0
                ? 'No token accounts observed in either token program.'
                : 'No tokens match the current filters.'}
            </p>
          )}
        </>
      ) : (
        !busy && (
          <p>No retained token holdings. Refresh to observe this wallet.</p>
        )
      )}
    </section>
  );
}
