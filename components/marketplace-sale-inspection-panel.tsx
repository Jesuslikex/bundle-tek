'use client';
import { useEffect, useRef, useState } from 'react';
import type { MarketplaceOwnedInventory } from '@/lib/marketplace-owned-inventory';
import type { OperatorListingReview } from '@/lib/marketplace-operator-review';
import {
  admitSaleInspection,
  type SaleInspection,
} from '@/lib/marketplace-sale-inspection-view';
import { marketplaceSol } from '@/lib/marketplace-catalog';
import { readPanelJson } from './read-panel-json';
import styles from './marketplace-owned-wallets.module.css';
function formatDifference(value: string | null | undefined) {
  if (value === null || value === undefined) return null;
  const amount = BigInt(value);
  return `${amount < 0n ? '−' : amount > 0n ? '+' : ''}${marketplaceSol((amount < 0n ? -amount : amount).toString())} SOL`;
}

export function MarketplaceSaleInspectionPanel({
  inventory,
  selection,
}: {
  inventory: MarketplaceOwnedInventory;
  selection: OperatorListingReview['selection'];
}) {
  const [result, setResult] = useState<SaleInspection | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(
      () => {
        setResult(null);
        setMessage(
          'Account inspection expired. Inspect again for a new snapshot.',
        );
      },
      Math.max(0, Date.parse(result.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [result]);
  function cancel() {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setResult(null);
    setMessage('Account inspection cancelled. Nothing was published or paid.');
  }
  async function inspect() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    const live = () =>
      pending.current === controller && !controller.signal.aborted;
    setBusy(true);
    setResult(null);
    setMessage('');
    try {
      const response = await fetch(
        '/api/marketplace/operator/account-inspection',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(selection),
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(60000),
          ]),
        },
      );
      const data = await readPanelJson(
        response,
        'Account inspection unavailable.',
      );
      if (!live()) return;
      if (!response.ok) {
        setMessage(
          response.status === 401
            ? 'Sign in before inspecting a seller wallet.'
            : response.status === 403
              ? 'Seller access changed. Sign in again.'
              : response.status === 409
                ? 'Seller evidence changed. Reload seller inventory and review again.'
                : response.status === 429
                  ? 'Rate limited. Wait at least 15 seconds, then inspect manually.'
                  : 'Account inspection unavailable. No sale or payment was authorized.',
        );
        return;
      }
      const admitted = admitSaleInspection(data, inventory, selection);
      if (live()) setResult(admitted);
    } catch {
      if (live())
        setMessage(
          'Account inspection could not be verified. Reload seller inventory and inspect again.',
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  const difference = result?.balanceDifferenceLamports;
  const signedSol = formatDifference(difference);
  return (
    <section
      className={styles.notice}
      aria-label="Current seller account inspection"
      aria-busy={busy}
    >
      <h2>Current account check</h2>
      <p>
        Read this wallet’s current SOL account before continuing sale
        preparation. This does not refresh its history or prove current key
        control.
      </p>
      <code>{selection.address}</code>
      <div className={styles.controls}>
        <button disabled={busy} onClick={() => void inspect()}>
          {busy
            ? 'Inspecting account…'
            : result
              ? 'Inspect account again'
              : 'Inspect current account'}
        </button>
        {busy && <button onClick={cancel}>Cancel account inspection</button>}
      </div>
      {message && <output>{message}</output>}
      {result && (
        <div aria-label="Account inspection result" aria-live="polite">
          <strong>
            {result.account.kind === 'system-wallet'
              ? 'Ordinary SOL account observed'
              : result.account.kind === 'absent'
                ? 'No on-chain account found'
                : 'Unsupported account type'}
          </strong>
          <dl>
            <div>
              <dt>Current SOL balance at observation</dt>
              <dd>{marketplaceSol(result.account.balanceLamports)} SOL</dd>
            </div>
            <div>
              <dt>Recorded SOL balance</dt>
              <dd>
                {result.historicalBalanceLamports === null
                  ? 'Not recorded'
                  : `${marketplaceSol(result.historicalBalanceLamports)} SOL`}
              </dd>
            </div>
            <div>
              <dt>Change from recorded balance</dt>
              <dd>{signedSol ?? 'No recorded balance to compare'}</dd>
            </div>
            <div>
              <dt>Provider and commitment</dt>
              <dd>
                {result.source} · {result.commitment}
              </dd>
            </div>
            <div>
              <dt>Observed</dt>
              <dd>{new Date(result.observedAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>{new Date(result.expiresAt).toLocaleTimeString()}</dd>
            </div>
          </dl>
          <details>
            <summary>Account evidence</summary>
            <p>
              Wallet revision {result.selection.walletRevision}. Slots{' '}
              {result.floorSlot} / {result.accountSlot} / {result.finalSlot}.
            </p>
            <p>Account owner</p>
            <code>{result.account.owner ?? 'No account owner'}</code>
            <p>
              Data size: {result.account.space ?? 'Unavailable'} bytes.
              Executable:{' '}
              {result.account.executable === null
                ? 'Unavailable'
                : result.account.executable
                  ? 'Yes'
                  : 'No'}
              .
            </p>
          </details>
          <p>
            Sale qualification is incomplete. Token holdings, provenance and
            current key control have not been checked. Balances are snapshots,
            not guaranteed funds included in a sale. Payment and key delivery
            remain unavailable.
          </p>
        </div>
      )}
    </section>
  );
}
