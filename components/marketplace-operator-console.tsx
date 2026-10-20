'use client';
import { useEffect, useRef, useState } from 'react';
import {
  admitMarketplaceOwnedInventory,
  MarketplaceInventoryClockError,
  type MarketplaceOwnedInventory,
} from '@/lib/marketplace-owned-inventory';
import { marketplaceLamports, marketplaceSol } from '@/lib/marketplace-catalog';
import {
  admitOperatorListingReview,
  type OperatorListingReview,
} from '@/lib/marketplace-operator-review';
import { readPanelJson } from './read-panel-json';
import styles from './marketplace-owned-wallets.module.css';
import { MarketplaceOperatorDrafts } from './marketplace-operator-drafts';
import { MarketplaceSaleInspectionPanel } from './marketplace-sale-inspection-panel';
import { MarketplaceTokenInspectionPanel } from './marketplace-token-inspection-panel';
import { MarketplaceControlEvidencePanel } from './marketplace-control-evidence-panel';
export function MarketplaceOperatorConsole() {
  const [inventory, setInventory] = useState<MarketplaceOwnedInventory | null>(
      null,
    ),
    [wallet, setWallet] = useState(''),
    [price, setPrice] = useState(''),
    [review, setReview] = useState<OperatorListingReview | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!inventory) return;
    const timer = setTimeout(
      () => {
        pending.current?.abort();
        pending.current = null;
        setBusy(false);
        setInventory(null);
        setReview(null);
        setMessage(
          'Seller inventory expired. Reload it before another review.',
        );
      },
      Math.max(0, Date.parse(inventory.observedAt) + 60000 - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [inventory]);
  useEffect(() => {
    if (!review) return;
    const timer = setTimeout(
      () => {
        setReview(null);
        setMessage('Listing review expired. Request a fresh review.');
      },
      Math.max(0, Date.parse(review.reviewExpiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [review]);
  function invalidate() {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setReview(null);
    setError('');
    setMessage('');
  }
  function cancel() {
    invalidate();
    setMessage('Seller review cancelled. Nothing was published.');
  }
  const selected = inventory?.wallets.find((w) => w.address === wallet);
  let priceLamports: string | null = null;
  try {
    const value = marketplaceLamports(price);
    if (value !== '0') priceLamports = value;
  } catch {}
  function begin() {
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    setMessage('');
    setReview(null);
    return controller;
  }
  const live = (c: AbortController) =>
    pending.current === c && !c.signal.aborted;
  async function load() {
    if (pending.current) return;
    const controller = begin();
    setInventory(null);
    setWallet('');
    setPrice('');
    try {
      const response = await fetch('/api/marketplace/operator/inventory', {
        cache: 'no-store',
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(10000),
        ]),
      });
      const data = await readPanelJson(
        response,
        'Seller inventory unavailable.',
      );
      if (!live(controller)) return;
      if (!response.ok) {
        setError(
          response.status === 401
            ? 'Sign in before opening seller inventory.'
            : response.status === 403
              ? 'Seller access is limited to configured Bundle operators. This screen cannot assign roles.'
              : 'Seller inventory unavailable. Nothing was published.',
        );
        return;
      }
      const result = admitMarketplaceOwnedInventory(data);
      if (live(controller)) {
        setInventory(result);
        setWallet(result.wallets[0]?.address ?? '');
      }
    } catch (error) {
      if (live(controller))
        setError(
          error instanceof MarketplaceInventoryClockError
            ? error.message
            : 'Seller inventory response could not be verified. No access or listing was granted.',
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  async function requestReview() {
    if (pending.current || !inventory || !selected || !priceLamports) return;
    const selection = {
        address: selected.address,
        walletRevision: selected.revision,
        priceLamports,
      },
      captured = inventory,
      controller = begin();
    try {
      const response = await fetch('/api/marketplace/operator/listing-review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(selection),
        cache: 'no-store',
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(10000),
        ]),
      });
      const data = await readPanelJson(response, 'Listing review unavailable.');
      if (!live(controller)) return;
      if (!response.ok) {
        setError(
          response.status === 403
            ? 'Seller access is no longer available. Nothing was published.'
            : response.status === 409
              ? 'Wallet evidence changed. Reload seller inventory and review again.'
              : 'Listing review unavailable. Nothing was published.',
        );
        return;
      }
      const result = await admitOperatorListingReview(
        data,
        captured,
        selection,
      );
      if (live(controller)) setReview(result);
    } catch {
      if (live(controller))
        setError(
          'Listing review differs or is unavailable. Reload seller inventory and review again.',
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <section
      className={styles.panel}
      aria-label="Bundle seller console"
      aria-busy={busy}
    >
      <p className={styles.eyebrow}>BUNDLE-OPERATED MARKETPLACE</p>
      <h1>Seller console</h1>
      <p>
        Only server-configured Bundle accounts can prepare wallet listings.
        Customer accounts cannot become sellers through this screen.
      </p>
      <div className={styles.notice}>
        <strong>Draft first, publication separate</strong>
        <p>
          Review the asking price and recorded evidence, then save the draft.
          Catalog publication requires a separate review and approval below.
          Payment, signing and key delivery remain unavailable.
        </p>
      </div>
      <div className={styles.controls}>
        <button onClick={() => void load()} disabled={busy}>
          {inventory ? 'Reload seller inventory' : 'Open seller inventory'}
        </button>
        {busy && <button onClick={cancel}>Cancel seller review</button>}
      </div>
      {error && <p role="alert">{error}</p>}
      {message && <output>{message}</output>}
      {inventory && (
        <>
          {inventory.wallets.length === 0 ? (
            <p>
              No active saved Solana wallets are available in this operator
              account.
            </p>
          ) : (
            <>
              <div className={styles.filters}>
                <label>
                  Operator wallet
                  <select
                    value={wallet}
                    onChange={(event) => {
                      invalidate();
                      setWallet(event.target.value);
                    }}
                  >
                    {inventory.wallets.map((w) => (
                      <option key={w.address} value={w.address}>
                        {w.label || 'Wallet'} ({w.address.slice(0, 4)}…
                        {w.address.slice(-4)})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Asking price (SOL)
                  <input
                    value={price}
                    maxLength={30}
                    inputMode="decimal"
                    onChange={(event) => {
                      invalidate();
                      setPrice(event.target.value);
                    }}
                    aria-invalid={price !== '' && !priceLamports}
                  />
                </label>
              </div>
              {!priceLamports && (
                <p>
                  Enter a positive SOL price with up to nine decimal places.
                  This does not create a payment.
                </p>
              )}
              <div className={styles.controls}>
                <button
                  disabled={busy || !selected || !priceLamports}
                  onClick={() => void requestReview()}
                >
                  Review listing draft
                </button>
              </div>
            </>
          )}
        </>
      )}
      {review && (
        <div
          className={styles.notice}
          aria-label="Operator listing draft review"
        >
          <h2>Unpublished listing review</h2>
          <code>{review.selection.address}</code>
          <dl>
            <div>
              <dt>Seller</dt>
              <dd>Bundle</dd>
            </div>
            <div>
              <dt>Asking price</dt>
              <dd>{marketplaceSol(review.selection.priceLamports)} SOL</dd>
            </div>
            <div>
              <dt>Wallet revision</dt>
              <dd>{review.selection.walletRevision}</dd>
            </div>
            <div>
              <dt>Historical control proof</dt>
              <dd>
                {review.evidence.ownershipProofAt
                  ? new Date(review.evidence.ownershipProofAt).toLocaleString()
                  : 'Not recorded'}
              </dd>
            </div>
            <div>
              <dt>Oldest retained activity</dt>
              <dd>
                {review.evidence.oldestRecordedActivityAt
                  ? new Date(
                      review.evidence.oldestRecordedActivityAt,
                    ).toLocaleString()
                  : 'Not established'}
              </dd>
            </div>
          </dl>
          <p>{review.disclosure}</p>
          <p>
            Recorded balances are not a live balance guarantee or part of an
            approved purchase. Review expires at{' '}
            {new Date(review.reviewExpiresAt).toLocaleTimeString()}.
          </p>
          <details>
            <summary>Exact review bindings</summary>
            <p>Request hash</p>
            <code>{review.requestSha256}</code>
            <p>Evidence hash</p>
            <code>{review.evidenceSha256}</code>
          </details>
          <p>
            This review does not publish a listing or authorize a purchase or
            signature.
          </p>
        </div>
      )}
      {review && inventory && (
        <MarketplaceControlEvidencePanel
          key={`control:${review.requestSha256}`}
          inventory={inventory}
          selection={review.selection}
        />
      )}
      {review && inventory && (
        <MarketplaceSaleInspectionPanel
          key={`native:${review.requestSha256}`}
          inventory={inventory}
          selection={review.selection}
        />
      )}
      {review && inventory && (
        <MarketplaceTokenInspectionPanel
          key={`tokens:${review.requestSha256}`}
          inventory={inventory}
          selection={review.selection}
        />
      )}
      <MarketplaceOperatorDrafts review={review} />
    </section>
  );
}
