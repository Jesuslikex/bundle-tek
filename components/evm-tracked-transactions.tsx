'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import type { TrackedWallet } from '@/lib/tracked-wallet';
import type { EvmTransactionObservation } from '@/lib/tracked-evm-transaction';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import type { TransferTokenIdentity } from '@/lib/evm-transfer-identity';
import { EvmTransactionDiscovery } from './evm-transaction-discovery';
function TransferAmount({
  raw,
  identity,
}: {
  raw: string;
  identity?: TransferTokenIdentity;
}) {
  return identity ? (
    <>
      <strong>
        {formatNativeBalance(raw, identity.decimals)} {identity.symbol}
      </strong>
      <br />
      {identity.name} · {identity.decimals} decimals
      <br />
      Raw: {raw}
      <br />
      Identity observed {new Date(identity.observedAt).toLocaleString()} ·{' '}
      {identity.source}
    </>
  ) : (
    <>Raw: {raw}</>
  );
}
type Saved = {
  transaction: EvmTransactionObservation;
  capturedUpdatedAt: string;
  stale: boolean;
};
export function EvmTrackedTransactions({ wallet }: { wallet: TrackedWallet }) {
  const [items, setItems] = useState<Saved[]>([]),
    [hash, setHash] = useState(''),
    [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const c = new AbortController();
    pending.current = c;
    void fetch(
      `/api/tracker/evm-transactions?${new URLSearchParams({ address: wallet.address, network: wallet.network, expectedUpdatedAt: wallet.updatedAt })}`,
      { signal: c.signal, cache: 'no-store' },
    )
      .then(async (response) => {
        const data = (await response.json()) as {
          error?: string;
          executionAllowed: boolean;
          currentUpdatedAt: string;
          observations: Saved[];
        };
        if (!response.ok)
          throw new Error(data.error || 'Saved EVM transactions unavailable.');
        if (
          data.executionAllowed !== false ||
          data.currentUpdatedAt !== wallet.updatedAt ||
          !Array.isArray(data.observations) ||
          data.observations.length > 100 ||
          data.observations.some(
            (r: Saved) =>
              r.transaction.chain !== wallet.network ||
              r.transaction.address !== wallet.address,
          )
        )
          throw new Error('Saved transaction context mismatch.');
        if (!c.signal.aborted) setItems(data.observations);
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Saved transactions unavailable.',
          );
      })
      .finally(() => {
        if (!c.signal.aborted) setBusy(false);
      });
    return () => pending.current?.abort();
  }, [wallet.address, wallet.network, wallet.updatedAt]);
  async function inspect(identityHash?: string) {
    if (busy || wallet.archived) return;
    const c = new AbortController();
    pending.current?.abort();
    pending.current = c;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/tracker/evm-transactions', {
        method: 'POST',
        signal: c.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          address: wallet.address,
          network: wallet.network,
          expectedUpdatedAt: wallet.updatedAt,
          hash: identityHash ?? hash.trim(),
          ...(identityHash ? { action: 'identity' } : {}),
        }),
      });
      const data = (await response.json()) as Saved & {
        error?: string;
        executionAllowed: boolean;
      };
      if (!response.ok)
        throw new Error(data.error || 'Transaction observation unavailable.');
      if (
        data.executionAllowed !== false ||
        data.capturedUpdatedAt !== wallet.updatedAt ||
        data.transaction?.chain !== wallet.network ||
        data.transaction.address !== wallet.address ||
        data.transaction.hash !== (identityHash ?? hash.trim()).toLowerCase()
      )
        throw new Error('Transaction context mismatch.');
      if (!c.signal.aborted)
        setItems((old) =>
          [
            data,
            ...old.filter((r) => r.transaction.hash !== data.transaction.hash),
          ].slice(0, 100),
        );
    } catch (e) {
      if (!c.signal.aborted)
        setError(
          e instanceof Error
            ? e.message
            : 'Transaction observation unavailable.',
        );
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  return (
    <section
      className="wallet-holdings-panel evm-transaction-history"
      aria-label="Saved EVM transaction observations"
    >
      <h3>EVM transaction history</h3>
      <p className="warmup-address">
        {wallet.label || 'Public address'} · {wallet.network}
        <br />
        {wallet.address}
      </p>
      <EvmTransactionDiscovery
        key={`${wallet.network}:${wallet.address}:${wallet.updatedAt}`}
        wallet={wallet}
        onSelect={setHash}
      />
      <p>
        Enter a known transaction hash to inspect sender, recipient or token
        transfer activity involving this address. Opening this view reads saved
        observations only. Up to 100 distinct transactions are retained per
        tracked address and network. Complete address history and internal
        native transfers are not indexed.
      </p>
      <label>
        Transaction hash
        <input
          value={hash}
          onChange={(e) => setHash(e.target.value)}
          disabled={busy || wallet.archived}
          placeholder="0x…"
          maxLength={66}
        />
      </label>
      <Button
        variant="outline"
        disabled={
          busy || wallet.archived || !/^0x[0-9a-fA-F]{64}$/.test(hash.trim())
        }
        onClick={() => void inspect()}
      >
        {busy ? 'Reading transactions…' : 'Inspect and save EVM transaction'}
      </Button>
      {wallet.archived && (
        <p>
          Archived address. Saved transactions remain readable; restore to
          inspect another hash.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {!busy && !items.length && <p>No EVM transaction observations saved.</p>}
      <p>{items.length} saved transaction observations.</p>
      {items.map(({ transaction: t, stale, capturedUpdatedAt }) => (
        <details key={t.hash} className="evm-transaction-observation">
          <summary>
            {t.status} · {t.direction} ·{' '}
            {new Date(t.blockTime).toLocaleString()} · {t.hash.slice(0, 14)}…
          </summary>
          <p style={{ overflowWrap: 'anywhere' }}>Hash: {t.hash}</p>
          <p style={{ overflowWrap: 'anywhere' }}>
            From: {t.from}
            <br />
            To: {t.to ?? 'Contract creation'}
          </p>
          <p>
            Declared native value: {t.value} {t.currency}. Raw units:{' '}
            {t.valueRaw}.
          </p>
          <p>
            Execution gas cost: {t.executionGasCost} {t.currency}. Raw units:{' '}
            {t.executionGasCostRaw}. Gas used: {t.gasUsed}. Effective gas price:{' '}
            {t.effectiveGasPriceRaw} native base units per gas.
          </p>
          {t.directParticipant === false && (
            <p>
              This wallet is involved through token events, not as the
              transaction sender or recipient. The native value and gas cost
              belong to the enclosing transaction.
            </p>
          )}
          <h4>Token transfer events</h4>
          {Array.isArray(t.transferEvents) ? (
            <>
              <p>
                {t.transferEvents.length} matching ERC-20-layout events from{' '}
                {t.receiptLogCount} receipt logs. Raw integers are always
                retained; readable amounts use observed decimals at this block.
                NFT events and unrelated transfers are omitted. Emitting
                contracts and balance changes are not independently verified.
              </p>
              {t.transferEvents.length > 0 && (
                <>
                  <Button
                    variant="outline"
                    disabled={busy || wallet.archived}
                    onClick={() => void inspect(t.hash)}
                  >
                    Read token identities at this block
                  </Button>
                  <p>
                    Identity and decimals are read from the saved transaction
                    block. Optional metadata or historical state may be
                    unavailable. Raw units are retained.
                  </p>
                  {t.tokenIdentity && (
                    <p>
                      Identity lookup{' '}
                      {new Date(t.tokenIdentity.observedAt).toLocaleString()}.{' '}
                      {t.tokenIdentity.unavailable.length} unavailable on the
                      latest attempt; previously saved identities may remain
                      visible.
                    </p>
                  )}
                  <div className="wallet-roster-table">
                    <table className="project-table">
                      <thead>
                        <tr>
                          <th>Log</th>
                          <th>Direction</th>
                          <th>Emitting contract</th>
                          <th>From / To</th>
                          <th>Token amount / raw units</th>
                        </tr>
                      </thead>
                      <tbody>
                        {t.transferEvents.map((event) => (
                          <tr key={event.logIndex}>
                            <td>{event.logIndex}</td>
                            <td>{event.direction}</td>
                            <td style={{ overflowWrap: 'anywhere' }}>
                              {event.contract}
                            </td>
                            <td style={{ overflowWrap: 'anywhere' }}>
                              {event.from}
                              <br />
                              {event.to}
                            </td>
                            <td style={{ overflowWrap: 'anywhere' }}>
                              <TransferAmount
                                raw={event.raw}
                                identity={t.tokenIdentity?.identities.find(
                                  (i) =>
                                    i.contract === event.contract &&
                                    i.blockHash === t.blockHash &&
                                    String(i.blockNumber) === t.blockNumber,
                                )}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          ) : (
            <p>
              Token events were not decoded for this saved observation. Inspect
              the hash again from an active tracked address to update it.
            </p>
          )}
          <p style={{ overflowWrap: 'anywhere' }}>
            Canonical block: {t.blockNumber} · {t.blockHash} · index{' '}
            {t.transactionIndex}.
          </p>
          <p>
            Input: {t.inputBytes} bytes. Selector: {t.selector ?? 'None'}.
          </p>
          <p>
            Observed {new Date(t.observedAt).toLocaleString()} · {t.source}.
            Captured wallet version {capturedUpdatedAt}.
          </p>
          {stale && (
            <p>
              Wallet metadata changed since inspection. This is a historical
              observation.
            </p>
          )}
          <p>
            {t.tokenIdentity
              ? t.limitations.replace(
                  'No token decimals, NFT decoding',
                  'No NFT decoding',
                )
              : t.limitations}
          </p>
        </details>
      ))}
    </section>
  );
}
