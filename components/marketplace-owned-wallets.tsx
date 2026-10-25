'use client';
import { MarketplaceSavedEvidenceBrowser } from './marketplace-saved-evidence-browser';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  admitMarketplaceOwnedInventory,
  type MarketplaceOwnedInventory,
  isMarketplaceInventoryCapacityResponse,
  MARKETPLACE_INVENTORY_CAPACITY_MESSAGE,
} from '@/lib/marketplace-owned-inventory';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { readPanelJson } from './read-panel-json';
import styles from './marketplace-owned-wallets.module.css';
export function MarketplaceOwnedWallets() {
  const [inventory, setInventory] = useState<MarketplaceOwnedInventory | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [signIn, setSignIn] = useState(false),
    [query, setQuery] = useState(''),
    [minimumDays, setMinimumDays] = useState(''),
    [sort, setSort] = useState('age'),
    [page, setPage] = useState(0);
  const [capacity, setCapacity] = useState(false);
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
        setInventory(null);
        setMessage(
          'Inventory view expired. Reload saved evidence to continue.',
        );
      },
      Math.max(0, Date.parse(inventory.observedAt) + 60000 - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [inventory]);
  async function load() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setCapacity(false);
    setInventory(null);
    setMessage('');
    setError('');
    setSignIn(false);
    setPage(0);
    let failureMessage = 'Saved inventory unavailable. Try again.';
    try {
      const response = await fetch('/api/marketplace/owned-wallets', {
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10000),
          ]),
        }),
        data = await readPanelJson(
          response,
          'Saved inventory unavailable. Try again.',
        );
      if (pending.current !== controller || controller.signal.aborted) return;
      if (response.status === 401) {
        setSignIn(true);
        failureMessage = 'Sign in to view your saved wallets.';
        throw Error('Sign in to view your saved wallets.');
      }
      if (!response.ok) {
        if (isMarketplaceInventoryCapacityResponse(response.status, data)) {
          setCapacity(true);
          setError(MARKETPLACE_INVENTORY_CAPACITY_MESSAGE);
          return;
        }
        failureMessage =
          'Saved inventory evidence is unavailable or inconsistent. No wallets were listed.';
        throw Error(
          'Saved inventory evidence is unavailable or inconsistent. No wallets were listed.',
        );
      }
      failureMessage =
        'Saved inventory response could not be verified. Reload it; listing remains disabled.';
      setInventory(admitMarketplaceOwnedInventory(data));
    } catch {
      if (pending.current === controller && !controller.signal.aborted)
        setError(failureMessage);
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  function cancel() {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setMessage('Inventory read cancelled. No wallet was changed.');
  }
  const validDays =
    minimumDays === '' ||
    (/^\d{1,5}$/.test(minimumDays) && Number(minimumDays) <= 36500);
  const rows =
    inventory && validDays
      ? inventory.wallets
          .filter(
            (w) =>
              (!query ||
                `${w.label} ${w.address}`
                  .toLowerCase()
                  .includes(query.toLowerCase())) &&
              (minimumDays === '' ||
                (w.observedActivityAgeSeconds !== null &&
                  w.observedActivityAgeSeconds >= Number(minimumDays) * 86400)),
          )
          .sort((a, b) =>
            sort === 'label'
              ? a.label.localeCompare(b.label) ||
                a.address.localeCompare(b.address)
              : (b.observedActivityAgeSeconds ?? -1) -
                  (a.observedActivityAgeSeconds ?? -1) ||
                a.address.localeCompare(b.address),
          )
      : [];
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(rows.length / 20) - 1),
  );
  return (
    <section
      className={styles.panel}
      aria-label="My saved wallet inventory"
      aria-busy={busy}
    >
      <p className={styles.eyebrow}>WALLET INVENTORY</p>
      <h1>My inventory</h1>
      <p>
        Track the evidence behind your saved Solana wallets. Nothing here lists
        a wallet for sale.
      </p>
      <div className={styles.notice}>
        <strong>Listing is not available yet</strong>
        <p>
          Payments, inventory reservations and secure key delivery still need to
          be connected. Historical control proofs cannot establish exclusive
          custody.
        </p>
      </div>
      <div className={styles.controls}>
        <button onClick={() => void load()} disabled={busy}>
          {inventory ? 'Refresh my inventory' : 'Load my inventory'}
        </button>
        {busy && <button onClick={cancel}>Cancel inventory read</button>}
        <Link href="/">Open Bundle workspace</Link>
      </div>
      {busy && (
        <output>
          Reading saved evidence. No provider calls, signing or funding.
        </output>
      )}
      {error && <p role="alert">{error}</p>}
      {capacity && <MarketplaceSavedEvidenceBrowser />}
      {message && <output>{message}</output>}
      {signIn && <Link href="/sign-in">Sign in to Bundle</Link>}
      {inventory && (
        <>
          <p>
            {inventory.wallets.length} saved{' '}
            {inventory.wallets.length === 1 ? 'wallet' : 'wallets'}. Inventory
            snapshot: {new Date(inventory.observedAt).toLocaleString()}.
          </p>
          <div className={styles.filters}>
            <label>
              Search wallets
              <input
                value={query}
                maxLength={80}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(0);
                }}
              />
            </label>
            <label>
              Minimum observed activity age (days)
              <input
                inputMode="numeric"
                value={minimumDays}
                placeholder="Any"
                onChange={(e) => {
                  setMinimumDays(e.target.value);
                  setPage(0);
                }}
                aria-invalid={!validDays}
              />
            </label>
            <label>
              Sort inventory
              <select
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value);
                  setPage(0);
                }}
              >
                <option value="age">Oldest recorded activity</option>
                <option value="label">Wallet label</option>
              </select>
            </label>
          </div>
          {!validDays && (
            <p role="alert">
              Choose a whole number from 0 to 36500 days, or leave the filter
              empty.
            </p>
          )}
          <p>
            Activity age means time since the oldest activity retained in a
            sampled history check. It is not a creation date or first-funding
            date. Counts below do not establish organic trading activity.
          </p>
          {validDays && rows.length === 0 && (
            <p>
              {inventory.wallets.length === 0
                ? 'No active saved Solana wallets. Create or import a wallet in the Bundle workspace first.'
                : 'No saved wallets match these filters. Wallets without dated evidence do not match an age filter.'}
            </p>
          )}
          <ul className={styles.wallets}>
            {rows.slice(currentPage * 20, (currentPage + 1) * 20).map((w) => (
              <li key={w.address}>
                <div className={styles.heading}>
                  <h2>{w.label || 'Unnamed wallet'}</h2>
                  <span>Not listed</span>
                </div>
                <code>{w.address}</code>
                <dl>
                  <div>
                    <dt>Observed activity age</dt>
                    <dd>
                      {w.observedActivityAgeSeconds === null
                        ? 'Not established'
                        : w.observedActivityAgeSeconds < 86400
                          ? 'Less than one day'
                          : `${Math.floor(w.observedActivityAgeSeconds / 86400)} days since a recorded activity`}
                    </dd>
                  </div>
                  <div>
                    <dt>Oldest retained activity</dt>
                    <dd>
                      {w.oldestRecordedActivityAt
                        ? new Date(
                            w.oldestRecordedActivityAt,
                          ).toLocaleDateString()
                        : 'Not established'}
                    </dd>
                  </div>
                  <div>
                    <dt>First funding / creation date</dt>
                    <dd>Not established</dd>
                  </div>
                  <div>
                    <dt>Historical control proof</dt>
                    <dd>
                      {w.ownershipProofAt
                        ? new Date(w.ownershipProofAt).toLocaleString()
                        : 'Not recorded'}
                    </dd>
                  </div>
                  <div>
                    <dt>Bundle warmup receipt entries</dt>
                    <dd>
                      {w.warmupReceiptCount} entries, {w.warmupUniqueSignatures}{' '}
                      unique recorded signatures
                    </dd>
                  </div>
                </dl>
                <details>
                  <summary>History evidence details</summary>
                  {w.latestHistory ? (
                    <>
                      <p>
                        Last successful saved check:{' '}
                        {new Date(w.latestHistory.observedAt).toLocaleString()}{' '}
                        via {w.latestHistory.source}.
                      </p>
                      <p>
                        Balance at that check:{' '}
                        {formatNativeBalance(
                          w.latestHistory.balanceLamports,
                          9,
                        )}{' '}
                        SOL. This is not a live balance.
                      </p>
                      <p>
                        {w.latestHistory.successfulSampleCount} successful
                        records in a {w.latestHistory.sampleCount}-signature
                        sample. Transactions were not decoded to establish
                        funding or trade type.
                      </p>
                      {w.latestHistory.walletRevision !== w.revision && (
                        <p>
                          Wallet details changed since the captured revision.
                          Refresh the history in the wallet workspace before
                          relying on it.
                        </p>
                      )}
                    </>
                  ) : (
                    <p>
                      No successful saved history check is available. An empty
                      or missing provider sample does not prove a new wallet.
                    </p>
                  )}
                  <p>
                    {w.savedHistoryChecks} saved successful checks;{' '}
                    {w.failedHistoryChecks} recorded failed checks. Warmup
                    counts are retained receipt metadata, not a fresh replay of
                    transactions.
                  </p>
                </details>
              </li>
            ))}
          </ul>
          {rows.length > 0 && (
            <div className={styles.controls}>
              <button
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                Previous inventory page
              </button>
              <span>
                {currentPage * 20 + 1} to{' '}
                {Math.min((currentPage + 1) * 20, rows.length)} of {rows.length}
              </span>
              <button
                disabled={(currentPage + 1) * 20 >= rows.length}
                onClick={() => setPage(currentPage + 1)}
              >
                Next inventory page
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
