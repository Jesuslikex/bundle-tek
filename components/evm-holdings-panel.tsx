'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { chainQuoteAssets } from '@/lib/quote-catalog';
import type { EvmChain } from '@/lib/evm-network';
import type { EvmHoldingsSnapshot } from '@/lib/evm-holdings';

export function EvmHoldingsPanel({
  chain,
  address,
  label,
  active,
  onClose,
  trackerUpdatedAt,
}: {
  chain: EvmChain;
  address: string;
  label: string;
  active: boolean;
  onClose: () => void;
  trackerUpdatedAt?: string;
}) {
  const [snapshot, setSnapshot] = useState<EvmHoldingsSnapshot | null>(null);
  const [contractsText, setContractsText] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const endpoint = trackerUpdatedAt
    ? '/api/tracker/evm-holdings'
    : '/api/wallet-workspace/evm-holdings';
  const controller = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    heading.current?.focus();
    const request = new AbortController();
    controller.current = request;
    void fetch(
      `${endpoint}?${new URLSearchParams(trackerUpdatedAt ? { network: chain, address, expectedUpdatedAt: trackerUpdatedAt } : { chain, address })}`,
      { cache: 'no-store', signal: request.signal },
    )
      .then(async (response) => {
        const data = (await response.json()) as {
          snapshot: EvmHoldingsSnapshot | null;
          error?: string;
          currentUpdatedAt?: string;
          executionAllowed?: boolean;
          stale?: boolean;
        };
        if (!response.ok)
          throw new Error(data.error || 'Token balances unavailable.');
        if (
          (data.snapshot &&
            (data.snapshot.chain !== chain ||
              data.snapshot.address !== address)) ||
          (trackerUpdatedAt &&
            (data.currentUpdatedAt !== trackerUpdatedAt ||
              data.executionAllowed !== false))
        )
          throw new Error('Token balance context mismatch.');
        if (!request.signal.aborted) {
          setSnapshot(data.snapshot);
          setStale(data.stale === true);
          setContractsText(
            data.snapshot?.holdings.map((item) => item.contract).join('\n') ??
              '',
          );
        }
      })
      .catch((failure) => {
        if (!request.signal.aborted) setError(failure.message);
      })
      .finally(() => {
        if (!request.signal.aborted) setBusy(false);
      });
    return () => controller.current?.abort();
  }, [chain, address, trackerUpdatedAt, endpoint]);
  const contracts = contractsText.split(/\s+/).filter(Boolean);
  const catalog = chainQuoteAssets(chain).filter(
    (asset) => !/^0x0{40}$/i.test(asset.address),
  );
  async function refresh() {
    if (busy || !active) return;
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
                network: chain,
                address,
                contracts,
                expectedUpdatedAt: trackerUpdatedAt,
              }
            : { chain, address, contracts },
        ),
        signal: request.signal,
      });
      const data = (await response.json()) as {
        snapshot: EvmHoldingsSnapshot | null;
        error?: string;
        currentUpdatedAt?: string;
        executionAllowed?: boolean;
      };
      if (!response.ok)
        throw new Error(data.error || 'Token balances unavailable.');
      if (
        !data.snapshot ||
        data.snapshot.chain !== chain ||
        data.snapshot.address !== address ||
        (trackerUpdatedAt &&
          (data.currentUpdatedAt !== trackerUpdatedAt ||
            data.executionAllowed !== false))
      )
        throw new Error('Token balance context mismatch.');
      if (!request.signal.aborted) {
        setSnapshot(data.snapshot);
        setStale(false);
        setContractsText(
          data.snapshot?.holdings.map((item) => item.contract).join('\n') ??
            contractsText,
        );
      }
    } catch (failure) {
      if (!request.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Token balances unavailable.',
        );
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="wallet-holdings-panel" aria-label="EVM token balances">
      <div className="wallet-roster-toolbar">
        <div>
          <h2 ref={heading} tabIndex={-1}>
            Token balances · {label || 'Unnamed wallet'}
          </h2>
          <p>
            {chain} · <code>{address}</code>
          </p>
        </div>
        <Button variant="outline" onClick={onClose}>
          Close holdings
        </Button>
      </div>
      <p className="source-note">
        Checks only the contracts you enter. Automatic discovery and prices are
        unavailable. Balances are observed units, not proof that transfers are
        allowed. Contracts must support balanceOf and decimals.
      </p>
      <label htmlFor="evm-token-contracts">
        Token contract addresses, one per line (1 to 20)
      </label>
      <textarea
        id="evm-token-contracts"

        value={contractsText}
        onChange={(event) => setContractsText(event.target.value)}
        disabled={busy || !active}
        rows={4}
        maxLength={2000}
      />
      <div className="wallet-roster-toolbar">
        <label>
          Add captured catalog contract
          <select
            aria-label="Add captured token contract"
            value=""
            disabled={busy || !active || contracts.length >= 20}
            onChange={(event) => {
              if (
                event.target.value &&
                !contracts.some(
                  (item) =>
                    item.toLowerCase() === event.target.value.toLowerCase(),
                )
              )
                setContractsText([...contracts, event.target.value].join('\n'));
            }}
          >
            <option value="">Choose a contract…</option>
            {catalog.map((asset) => (
              <option key={asset.address} value={asset.address}>
                {asset.symbol} · {asset.address}
              </option>
            ))}
          </select>
        </label>
        <Button
          disabled={
            busy || !active || contracts.length < 1 || contracts.length > 20
          }
          onClick={() => void refresh()}
        >
          {busy ? 'Loading balances…' : 'Refresh token balances'}
        </Button>
      </div>
      <p className="source-note">
        Catalog labels are captured references. Contract decimals are read from
        the selected network.
      </p>
      {error && (
        <p role="alert" className="draft-error">
          {error}
        </p>
      )}
      {!active && (
        <p className="source-note">
          Restore the{' '}
          {trackerUpdatedAt ? 'tracked address' : 'wallet and folder'} to
          refresh. Retained observations remain available.
        </p>
      )}
      {snapshot ? (
        <>
          {stale && (
            <p className="source-note">
              Wallet metadata changed after this observation. The saved token
              balances remain historical.
            </p>
          )}
          <p className="source-note">
            Observed {new Date(snapshot.observedAt).toLocaleString()} ·{' '}
            {snapshot.source} · block {snapshot.blockNumber} ·{' '}
            {snapshot.holdings.length} checked contracts
          </p>
          <details>
            <summary>Observation block hash</summary>
            <code>{snapshot.blockHash}</code>
          </details>
          <div className="wallet-roster-table evm-token-balance-table">
            <table className="project-table">
              <thead>
                <tr>
                  <th>Token contract</th>
                  <th>Observed balance</th>
                  <th>Raw units</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.holdings.map((item) => (
                  <tr key={item.contract}>
                    <td data-label="Token contract">
                      <code>{item.contract}</code>
                    </td>
                    <td data-label="Observed balance">
                      <strong>{item.amount}</strong>
                      <small>{item.decimals} decimals</small>
                    </td>
                    <td data-label="Raw units">
                      <code>{item.raw}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        !busy && (
          <p>No retained token balances. Choose contracts and refresh.</p>
        )
      )}
    </section>
  );
}
