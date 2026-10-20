'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { BundleCatalog } from '@/lib/marketplace-publication';
import {
  admitMarketplaceCart,
  buildCartRequest,
  selectedAskingPrice,
  type CartReview,
} from '@/lib/marketplace-cart';
import { marketplaceSol } from '@/lib/marketplace-catalog';
import { readPanelJson } from './read-panel-json';
import styles from './marketplace-owned-wallets.module.css';
import cartStyles from './marketplace-cart.module.css';
function selectionTotal(catalog: BundleCatalog, ids: string[]) {
  try {
    return ids.length ? selectedAskingPrice(catalog, ids) : '0';
  } catch {
    return null;
  }
}
type CartProps = {
  catalog: BundleCatalog;
  ids: string[];
  hiddenCount: number;
  onRemove: (id: string) => void;
  onClear: () => void;
  stale?: boolean;
};
export function MarketplaceCartReview(props: CartProps) {
  // A changed snapshot, selection or expiry state owns a fresh review instance.
  // Unmount cleanup cancels the old request before it can publish a late result.
  const key = JSON.stringify([
    props.catalog,
    [...props.ids].sort(),
    props.stale ?? false,
  ]);
  return <CartReviewPanel key={key} {...props} />;
}
function CartReviewPanel({
  catalog,
  ids,
  hiddenCount,
  onRemove,
  onClear,
  stale = false,
}: CartProps) {
  const pending = useRef<AbortController | null>(null);
  const [review, setReview] = useState<CartReview | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [signIn, setSignIn] = useState(false);
  const total = selectionTotal(catalog, ids);
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!review) return;
    const timer = setTimeout(
      () => {
        setReview(null);
        setMessage(
          'Cart review expired. Request a fresh review before continuing.',
        );
      },
      Math.max(0, Date.parse(review.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [review]);
  const live = (c: AbortController) =>
    pending.current === c && !c.signal.aborted;
  function stop() {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setMessage('Cart review cancelled. No reservation or purchase was sent.');
  }
  async function inspect() {
    if (pending.current || ids.length === 0 || total === null || stale) return;
    const c = new AbortController();
    pending.current = c;
    setBusy(true);
    setReview(null);
    setError('');
    setMessage('');
    setSignIn(false);
    try {
      const selection = await buildCartRequest(catalog, ids);
      if (!live(c)) return;
      const response = await fetch('/api/marketplace/cart-review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(selection),
        cache: 'no-store',
        signal: AbortSignal.any([c.signal, AbortSignal.timeout(10000)]),
      });
      const body = await readPanelJson(response, 'Cart review unavailable.');
      if (!live(c)) return;
      if (!response.ok) {
        setSignIn(response.status === 401);
        setError(
          response.status === 401
            ? 'Sign in before reviewing selected wallets.'
            : response.status === 409
              ? 'A selected wallet or its details changed. Refresh inventory, check the selection and review again.'
              : 'Cart review is unavailable. No reservation or purchase was sent.',
        );
        return;
      }
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !Object.hasOwn(body, 'review')
      )
        throw Error('Invalid cart response');
      const checked = await admitMarketplaceCart(
        (body as { review: unknown }).review,
        catalog,
        selection,
      );
      if (live(c)) setReview(checked);
    } catch {
      if (live(c))
        setError(
          'Cart review could not be verified. Refresh inventory and review the exact selection again.',
        );
    } finally {
      if (pending.current === c) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <section
      className={styles.notice}
      aria-label="Selected wallet cart"
      aria-busy={busy}
    >
      <h2>Selected wallets · {ids.length}</h2>
      <p>
        Selection asking price:{' '}
        {total === null ? 'Unavailable' : `${marketplaceSol(total)} SOL`}.
        Network fees are not quoted. Historical balances do not reduce this
        amount.
      </p>
      {total === null && (
        <p role="alert">
          The selection total exceeds the supported SOL amount or a listing is
          unavailable. Remove wallets or refresh inventory before reviewing.
        </p>
      )}
      {hiddenCount > 0 && (
        <p>
          {hiddenCount} selected{' '}
          {hiddenCount === 1 ? 'wallet is' : 'wallets are'} outside the current
          filters. Changing filters does not remove them from your selection.
        </p>
      )}
      <div className={styles.controls}>
        <button
          disabled={busy || ids.length === 0 || total === null || stale}
          onClick={() => void inspect()}
        >
          Review selected wallets
        </button>
        {ids.length > 0 && (
          <button onClick={onClear}>Clear wallet selection</button>
        )}
        {busy && <button onClick={stop}>Cancel cart review</button>}
      </div>
      {ids.length === 0 && (
        <p>
          Choose wallets individually or use the matching-wallet count. You can
          review up to 200 at once.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {stale && (
        <p>
          Selection retained as an unverified draft. Refresh Bundle inventory
          before requesting another review.
        </p>
      )}
      {signIn && <Link href="/sign-in">Sign in</Link>}
      {message && <output>{message}</output>}
      {ids.length > 0 && (
        <details>
          <summary>Selection details</summary>
          <ul className={cartStyles.rows}>
            {catalog.listings
              .filter((e) => ids.includes(e.id))
              .map((e) => (
                <li key={e.id}>
                  <div>
                    <code>{e.listing.address}</code>
                    <span>{marketplaceSol(e.listing.priceLamports)} SOL</span>
                  </div>
                  <button
                    aria-label={`Remove ${e.listing.address} from selection`}
                    onClick={() => onRemove(e.id)}
                  >
                    Remove
                  </button>
                </li>
              ))}
          </ul>
        </details>
      )}
      {review && (
        <div aria-label="Verified wallet cart review">
          <h3>Selection checked · not reserved</h3>
          <dl>
            <div>
              <dt>Network</dt>
              <dd>Solana</dd>
            </div>
            <div>
              <dt>Seller</dt>
              <dd>Bundle</dd>
            </div>
            <div>
              <dt>Wallets</dt>
              <dd>{review.count}</dd>
            </div>
            <div>
              <dt>Total asking price</dt>
              <dd>{marketplaceSol(review.askingPriceLamports)} SOL</dd>
            </div>
            <div>
              <dt>Network fees</dt>
              <dd>Not quoted or included</dd>
            </div>
            <div>
              <dt>Review expires</dt>
              <dd>{new Date(review.expiresAt).toLocaleTimeString()}</dd>
            </div>
          </dl>
          <p>
            Availability was checked against the current catalog. These wallets
            are not reserved and may be withdrawn. Checkout, payment, signing
            and secure delivery remain unavailable.
          </p>
          <details>
            <summary>Exact cart review</summary>
            <code>{review.contextSha256}</code>
            <ul className={cartStyles.rows}>
              {review.items.map((e) => (
                <li key={e.id}>
                  <div>
                    <code>{e.listing.address}</code>
                    <span>{marketplaceSol(e.listing.priceLamports)} SOL</span>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </section>
  );
}
