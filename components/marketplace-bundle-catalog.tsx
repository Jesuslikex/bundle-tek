'use client';
import { useContext, useEffect, useId, useRef, useState } from 'react';
import { MarketplaceReservationContext } from './marketplace-reservation-context';
import Link from 'next/link';
import {
  admitBundleCatalog,
  type BundleCatalog,
} from '@/lib/marketplace-publication';
import { marketplaceLamports, marketplaceSol } from '@/lib/marketplace-catalog';
import { readPanelJson } from './read-panel-json';
import styles from './marketplace-owned-wallets.module.css';
import cartStyles from './marketplace-cart.module.css';
import { MarketplaceCartReview } from './marketplace-cart-review';
import { CART_MAX_WALLETS } from '@/lib/marketplace-cart';
function filtered(
  catalog: BundleCatalog | null,
  age: string,
  price: string,
  sort: string,
) {
  if (!catalog) return { listings: [], valid: true };
  if (!/^(0|[1-9]\d{0,4})$/.test(age) || Number(age) > 36500)
    return { listings: [], valid: false };
  let cap: bigint | null = null;
  try {
    if (price) cap = BigInt(marketplaceLamports(price));
  } catch {
    return { listings: [], valid: false };
  }
  const at = Date.parse(catalog.observedAt),
    days = Number(age);
  const listings = catalog.listings.filter(
    (e) =>
      (days === 0 ||
        (e.listing.oldestRecordedActivityAt !== null &&
          at - Date.parse(e.listing.oldestRecordedActivityAt) >=
            days * 86400000)) &&
      (cap === null || BigInt(e.listing.priceLamports) <= cap),
  );
  listings.sort((a, b) => {
    if (sort === 'activity') {
      const av = a.listing.oldestRecordedActivityAt,
        bv = b.listing.oldestRecordedActivityAt;
      return av === bv
        ? a.id.localeCompare(b.id)
        : av === null
          ? 1
          : bv === null
            ? -1
            : av.localeCompare(bv);
    }
    const av = BigInt(a.listing.priceLamports),
      bv = BigInt(b.listing.priceLamports);
    return av === bv ? a.id.localeCompare(b.id) : av < bv ? -1 : 1;
  });
  return { listings, valid: true };
}
export function MarketplaceBundleCatalog() {
  const viewName = useId();
  const [view, setView] = useState<'compact' | 'cards'>('compact');
  const countHelpId = useId(),
    countErrorId = useId();
  const version = useContext(MarketplaceReservationContext)?.version ?? 0;
  const pending = useRef<AbortController | null>(null);
  const [catalog, setCatalog] = useState<BundleCatalog | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [expired, setExpired] = useState(false),
    [signIn, setSignIn] = useState(false),
    [age, setAge] = useState('0'),
    [price, setPrice] = useState(''),
    [sort, setSort] = useState('price'),
    [page, setPage] = useState(0),
    [ids, setIds] = useState<string[]>([]),
    [requestedCount, setRequestedCount] = useState('25'),
    [selectionMessage, setSelectionMessage] = useState(''),
    [catalogVersion, setCatalogVersion] = useState(version);
  const unavailable = expired || catalogVersion !== version;
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!catalog) return;
    const timer = setTimeout(
      () => {
        if (ids.length === 0) setCatalog(null);
        setExpired(true);
      },
      Math.max(0, Date.parse(catalog.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [catalog, ids.length]);
  function stop() {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setError('Catalog read cancelled. No purchase was sent.');
  }
  async function load() {
    if (pending.current) return;
    const c = new AbortController();
    pending.current = c;
    setBusy(true);
    setError('');
    setCatalog(null);
    setExpired(false);
    setSignIn(false);
    setPage(0);
    try {
      const response = await fetch('/api/marketplace/bundle-catalog', {
        cache: 'no-store',
        signal: AbortSignal.any([c.signal, AbortSignal.timeout(10000)]),
      });
      const body = await readPanelJson(response, 'Bundle catalog unavailable.');
      if (pending.current !== c || c.signal.aborted) return;
      if (!response.ok) {
        setSignIn(response.status === 401);
        setError(
          response.status === 401
            ? 'Sign in to browse Bundle inventory.'
            : 'Bundle inventory is unavailable. No purchase was authorized.',
        );
        return;
      }
      const checked = admitBundleCatalog(body);
      if (pending.current === c && !c.signal.aborted) {
        const retained = ids.filter((id) =>
          checked.listings.some((e) => e.id === id),
        );
        setIds(retained);
        setSelectionMessage(
          ids.length > retained.length
            ? `${ids.length - retained.length} previously selected ${ids.length - retained.length === 1 ? 'wallet is no longer available and was' : 'wallets are no longer available and were'} removed.`
            : '',
        );
        setCatalog(checked);
        setCatalogVersion(version);
      }
    } catch {
      if (pending.current === c && !c.signal.aborted)
        setError(
          'Bundle inventory response could not be verified. No purchase was authorized.',
        );
    } finally {
      if (pending.current === c) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  const selected = filtered(catalog, age, price, sort),
    start = page * 20,
    visible = selected.listings.slice(start, start + 20);
  const countValid =
    /^[1-9]\d{0,2}$/.test(requestedCount) &&
    Number(requestedCount) <= CART_MAX_WALLETS;
  const matchingIds = new Set(selected.listings.map((e) => e.id));
  function chooseMatching() {
    if (!countValid || !selected.valid || unavailable) return;
    const chosen = selected.listings
      .slice(0, Number(requestedCount))
      .map((e) => e.id);
    setIds(chosen);
    setSelectionMessage(
      chosen.length < Number(requestedCount)
        ? `Only ${chosen.length} ${chosen.length === 1 ? 'wallet matches' : 'wallets match'}; selected ${chosen.length} of the requested ${requestedCount}.`
        : `Selected ${chosen.length} matching wallets. Previous selection was replaced.`,
    );
  }
  function toggle(id: string) {
    if (unavailable) return;
    setSelectionMessage('');
    setIds((previous) =>
      previous.includes(id)
        ? previous.filter((x) => x !== id)
        : previous.length < CART_MAX_WALLETS
          ? [...previous, id]
          : previous,
    );
  }
  return (
    <section
      className={styles.panel}
      aria-label="Bundle wallet catalog"
      aria-busy={busy}
    >
      <p className={styles.eyebrow}>BUNDLE-OPERATED INVENTORY</p>
      <h1>Wallet marketplace</h1>
      <p>
        Browse listings published by Bundle. Customer accounts cannot sell
        wallets here. Checkout unavailable.
      </p>
      <div className={styles.notice}>
        <strong>Recorded history, with its limits</strong>
        <p>
          Recorded activity age is not wallet creation or funding age.
          Historical balances are not current balances or an approved purchase
          entitlement. Checkout, payment and secure delivery are not connected.
        </p>
      </div>
      <div className={styles.controls}>
        <button disabled={busy} onClick={() => void load()}>
          Refresh Bundle inventory
        </button>
        {busy && <button onClick={stop}>Cancel catalog read</button>}
      </div>
      {error && <p role="alert">{error}</p>}
      {signIn && <Link href="/sign-in">Sign in</Link>}
      {expired && (
        <p>
          Catalog view expired. Refresh for a new snapshot. Selected wallets are
          retained as an unverified draft.
        </p>
      )}
      {catalog && catalogVersion !== version && (
        <p>
          A wallet hold may have changed availability. Refresh inventory before
          selecting or reviewing again.
        </p>
      )}
      {catalog && (
        <>
          <div className={styles.filters}>
            <label>
              Minimum recorded activity age (days)
              <input
                inputMode="numeric"
                value={age}
                onChange={(e) => {
                  setAge(e.target.value);
                  setPage(0);
                }}
              />
            </label>
            <label>
              Maximum asking price (SOL)
              <input
                inputMode="decimal"
                value={price}
                onChange={(e) => {
                  setPrice(e.target.value);
                  setPage(0);
                }}
              />
            </label>
            <label>
              Sort listings
              <select
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value);
                  setPage(0);
                }}
              >
                <option value="price">Asking price</option>
                <option value="activity">Oldest recorded activity</option>
              </select>
            </label>
          </div>
          <div className={styles.filters}>
            <label>
              Wallet count
              <input
                inputMode="numeric"
                maxLength={3}
                aria-invalid={!countValid}
                aria-describedby={
                  countValid ? countHelpId : `${countHelpId} ${countErrorId}`
                }
                value={requestedCount}
                onChange={(e) => {
                  setRequestedCount(e.target.value);
                  setSelectionMessage('');
                }}
              />
            </label>
          </div>
          <fieldset className={`${styles.controls} ${styles.countPresets}`}>
            <legend>Wallet count presets</legend>
            {[25, 50, 100, 200].map((count) => (
              <button
                key={count}
                type="button"
                aria-pressed={requestedCount === String(count)}
                onClick={() => {
                  setRequestedCount(String(count));
                  setSelectionMessage('');
                }}
              >
                {count}
              </button>
            ))}
          </fieldset>
          <p id={countHelpId}>
            Select up to this many matching wallets in the displayed sort order.
            Choosing a count does not select or reserve wallets. Select matching
            wallets to replace the current selection.
          </p>
          <div className={styles.controls}>
            <button
              disabled={
                !countValid ||
                !selected.valid ||
                selected.listings.length === 0 ||
                unavailable
              }
              onClick={chooseMatching}
            >
              Select matching wallets
            </button>
          </div>
          {!countValid && (
            <p role="alert" id={countErrorId}>
              Choose a wallet count from 1 to 200.
            </p>
          )}
          {selectionMessage && <output>{selectionMessage}</output>}
          {ids.length === CART_MAX_WALLETS && (
            <p>
              Maximum 200 wallets selected. Remove a wallet before selecting
              another.
            </p>
          )}
          {ids.length > 0 && (
            <MarketplaceCartReview
              catalog={catalog}
              ids={ids}
              hiddenCount={ids.filter((id) => !matchingIds.has(id)).length}
              onRemove={(id) => {
                setIds((previous) => previous.filter((x) => x !== id));
                setSelectionMessage('');
              }}
              onClear={() => {
                setIds([]);
                setSelectionMessage('');
              }}
              stale={unavailable}
            />
          )}
          {!selected.valid ? (
            <p role="alert">
              Choose a whole activity age from 0 to 36500 days and a valid SOL
              price.
            </p>
          ) : (
            <>
              <fieldset className={styles.viewOptions}>
                <legend>Listing view</legend>
                {(['compact', 'cards'] as const).map((value) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name={viewName}
                      value={value}
                      checked={view === value}
                      onChange={() => setView(value)}
                    />
                    {value === 'compact' ? 'Compact rows' : 'Detailed cards'}
                  </label>
                ))}
              </fieldset>
              <p>
                {selected.listings.length === 0
                  ? 'No published Bundle wallets match these filters.'
                  : `${start + 1} to ${Math.min(start + 20, selected.listings.length)} of ${selected.listings.length} published listings.`}
              </p>
              <ul
                className={`${styles.wallets} ${view === 'compact' ? styles.compact : ''}`}
                data-view={view}
              >
                {visible.map((e) => (
                  <li key={e.id}>
                    <label className={cartStyles.choice}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${e.listing.address}`}
                        checked={ids.includes(e.id)}
                        disabled={
                          unavailable ||
                          (ids.length >= CART_MAX_WALLETS &&
                            !ids.includes(e.id))
                        }
                        onChange={() => toggle(e.id)}
                      />
                      <span>Select wallet</span>
                    </label>
                    <h2 aria-label={`Bundle wallet ${e.listing.address}`}>
                      Bundle wallet
                    </h2>
                    <code>{e.listing.address}</code>
                    <dl>
                      <div>
                        <dt>Asking price</dt>
                        <dd>{marketplaceSol(e.listing.priceLamports)} SOL</dd>
                      </div>
                      <div>
                        <dt>Oldest recorded activity</dt>
                        <dd>
                          {e.listing.oldestRecordedActivityAt
                            ? new Date(
                                e.listing.oldestRecordedActivityAt,
                              ).toLocaleString()
                            : 'Not established'}
                        </dd>
                      </div>
                      <div>
                        <dt>Historical balance</dt>
                        <dd>
                          {e.listing.historicalBalance
                            ? `${marketplaceSol(e.listing.historicalBalance.balanceLamports)} SOL, observed ${new Date(e.listing.historicalBalance.observedAt).toLocaleString()}`
                            : 'Not recorded'}
                        </dd>
                      </div>
                      <div>
                        <dt>Listing published</dt>
                        <dd>{new Date(e.publishedAt).toLocaleString()}</dd>
                      </div>
                    </dl>
                    <p>Purchase unavailable</p>
                    <details>
                      <summary>Evidence and custody disclosure</summary>
                      <p>{e.listing.disclosure}</p>
                      <p>
                        {e.listing.savedHistoryChecks} saved history checks;{' '}
                        {e.listing.warmupUniqueSignatures} unique recorded
                        warmup signatures. This is not complete chain coverage
                        or a fresh receipt replay.
                      </p>
                    </details>
                  </li>
                ))}
              </ul>
              <div className={styles.controls}>
                {page > 0 && (
                  <button onClick={() => setPage(page - 1)}>
                    Previous catalog page
                  </button>
                )}
                {start + 20 < selected.listings.length && (
                  <button onClick={() => setPage(page + 1)}>
                    Next catalog page
                  </button>
                )}
              </div>
            </>
          )}
          <p>
            Snapshot: {new Date(catalog.observedAt).toLocaleString()}. Withdrawn
            listings are excluded from subsequent refreshes. No wallet is
            reserved by browsing.
          </p>
        </>
      )}
    </section>
  );
}
