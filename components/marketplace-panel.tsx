'use client';
import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import {
  marketplaceResult,
  marketplaceFilters,
  marketplaceLamports,
  marketplaceSol,
  sortMarketplaceListings,
  type MarketplaceSort,
  type MarketplaceResult,
} from '@/lib/marketplace-catalog';
import styles from './marketplace-panel.module.css';
const tierLabels = {
  'funding-only': 'Funding only',
  'light-history': 'Light history',
  established: 'Established',
} as const;
const displaySortLabels = {
  price: 'Price',
  balance: 'SOL balance',
  net: 'Price less balance',
  funded: 'Funding time',
  transactions: 'Transactions',
} as const;

export function MarketplacePanel() {
  const regionHelpId = useId();
  const [result, setResult] = useState<MarketplaceResult | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [signIn, setSignIn] = useState(false),
    [expired, setExpired] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const [count, setCount] = useState('25');
  const [source, setSource] = useState('');
  const [sourceOptions, setSourceOptions] = useState<string[]>([]);
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [region, setRegion] = useState('');
  const [regionOptions, setRegionOptions] = useState<string[]>([]);
  const [regionsLoaded, setRegionsLoaded] = useState(false);
  const [selectedRegions, setSelectedRegions] = useState<string[]>([]);
  const [selectedTiers, setSelectedTiers] = useState<string[]>([]);
  const [sort, setSort] = useState<{
    key: MarketplaceSort;
    descending: boolean;
  }>({ key: 'price', descending: false });
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(result.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [result]);
  function invalidate() {
    pending.current?.abort();
    setBusy(false);
    setResult(null);
    setExpired(false);
    setError('');
  }
  async function load(event: {
    preventDefault(): void;
    currentTarget: HTMLFormElement;
  }) {
    event.preventDefault();
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    setResult(null);
    setSignIn(false);
    setExpired(false);
    try {
      const params = new URLSearchParams();
      const amounts: Record<string, string> = {
        minimumBalanceSol: 'minimumBalanceLamports',
        maximumBalanceSol: 'maximumBalanceLamports',
        maximumPriceSol: 'maximumPriceLamports',
      };
      for (const [key, value] of values)
        if (typeof value === 'string' && value)
          params.set(
            amounts[key] ?? key,
            amounts[key] ? marketplaceLamports(value) : value,
          );
      const parsed = marketplaceFilters.safeParse(Object.fromEntries(params));
      if (params.toString().length > 2048)
        throw new Error(
          'Choose fewer sources or regions, or shorter filters before refreshing.',
        );
      if (!parsed.success)
        throw new Error(
          parsed.error.issues.some(
            (issue) =>
              issue.path[0] === 'region' || issue.path[0] === 'regions',
          )
            ? 'Enter a region exactly as reported, or choose from the reported regions.'
            : 'Check your filter ranges. Maximum values must be at or above their minimums.',
        );
      const response = await fetch(`/api/marketplace/catalog?${params}`, {
        signal: controller.signal,
        cache: 'no-store',
      });
      const body: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;
      if (response.status === 401) {
        setSignIn(true);
        throw new Error('Sign in to browse wallet inventory.');
      }
      if (!response.ok) {
        throw new Error(
          response.status === 503 &&
            body &&
            typeof body === 'object' &&
            'code' in body &&
            body.code === 'AUTH_UNAVAILABLE'
            ? 'Bundle sign-in is temporarily unavailable. Try again later.'
            : response.status === 503
              ? 'No wallet inventory is available. A verified provider must be connected before purchases can be supported.'
              : response.status === 429
                ? 'Inventory provider is rate limited. Try again later.'
                : 'Inventory could not be loaded. Try again later.',
        );
      }
      const data = marketplaceResult.parse(body);
      if (JSON.stringify(data.filters) !== JSON.stringify(parsed.data))
        throw new Error(
          'Inventory filters differ from your selection. Refresh to continue.',
        );
      if (
        Date.parse(data.expiresAt) <= Date.now() ||
        Date.parse(data.observedAt) > Date.now()
      )
        throw new Error('Inventory snapshot has expired. Refresh to continue.');
      setResult(data);
      setSourceOptions(data.sources);
      setRegionOptions(data.regions ?? []);
      setRegionsLoaded(true);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error && !('issues' in reason)
            ? reason.message
            : 'Inventory response was invalid.',
        );
    } finally {
      if (pending.current === controller) setBusy(false);
    }
  }
  const sortHeader = (key: MarketplaceSort, title: string) => (
    <th
      scope="col"
      aria-sort={
        sort.key === key
          ? sort.descending
            ? 'descending'
            : 'ascending'
          : 'none'
      }
    >
      <button
        type="button"
        className={styles.sortButton}
        onClick={() =>
          setSort((current) => ({
            key,
            descending: current.key === key ? !current.descending : false,
          }))
        }
      >
        {title}
        {sort.key === key ? (sort.descending ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  );
  const displayed = result
    ? sortMarketplaceListings(result.listings, sort.key, sort.descending)
    : [];
  const netCost = (item: MarketplaceResult['listings'][number]) =>
    marketplaceSol(
      String(BigInt(item.purchasePriceLamports) - BigInt(item.balanceLamports)),
    );
  return (
    <section className={styles.panel} aria-labelledby="marketplace-title">
      <header>
        <p className={styles.eyebrow}>BUNDLE TEK / WALLET INVENTORY</p>
        <h1 id="marketplace-title">Wallet marketplace</h1>
        <p>
          Browse provider-reported wallet history and compare acquisition costs.
        </p>
        <span className={styles.badge}>
          Catalog preview · Checkout unavailable
        </span>
      </header>
      <form
        onSubmit={load}
        onChange={invalidate}
        onReset={() => {
          invalidate();
          setCount('25');
          setSource('');
          setSelectedSources([]);
          setRegion('');
          setSelectedRegions([]);
          setSelectedTiers([]);
          setSort({ key: 'price', descending: false });
        }}
        className={styles.filters}
      >
        <div>
          <label>
            Wallet count
            <input
              name="count"
              type="number"
              min="1"
              max="200"
              step="1"
              required
              value={count}
              onChange={(event) => setCount(event.target.value)}
            />
          </label>
          <div className={styles.countPresets}>
            {[25, 50, 100, 200].map((value) => (
              <button
                type="button"
                key={value}
                aria-label={`Choose ${value} wallets`}
                onClick={() => {
                  setCount(String(value));
                  invalidate();
                }}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
        <label>
          Minimum funding age (days)
          <input
            name="minimumAgeDays"
            type="number"
            min="1"
            max="36500"
            defaultValue="1"
            required
          />
        </label>
        <label>
          Funding gap between selected wallets (minutes)
          <input
            name="minimumGapMinutes"
            type="number"
            min="0"
            max="525600"
            defaultValue="30"
            required
          />
        </label>
        <details className={styles.advanced}>
          <summary>Advanced filters</summary>
          <p>
            Optional ranges apply to this provider snapshot. Funding age is time
            since reported funding, not wallet creation age.
          </p>
          <div className={styles.rangeGrid}>
            <fieldset className={styles.choices}>
              <legend>History tiers</legend>
              <small>
                Choose any combination. None selected means all tiers.
              </small>
              {(['funding-only', 'light-history', 'established'] as const).map(
                (value, index) => (
                  <label key={value}>
                    <input
                      type="checkbox"
                      checked={selectedTiers.includes(value)}
                      onChange={(event) =>
                        setSelectedTiers((current) =>
                          event.target.checked
                            ? [...current, value]
                            : current.filter((item) => item !== value),
                        )
                      }
                    />
                    {['Funding only', 'Light history', 'Established'][index]}
                  </label>
                ),
              )}
              {selectedTiers.length > 0 && (
                <input
                  type="hidden"
                  name="tiers"
                  value={JSON.stringify(selectedTiers)}
                />
              )}
            </fieldset>
            <label>
              Funding source
              <input
                name="source"
                maxLength={80}
                placeholder="One exact source or choose below"
                value={source}
                onChange={(event) => {
                  setSource(event.target.value);
                  setSelectedSources([]);
                }}
              />
            </label>
            <fieldset className={styles.choices}>
              <legend>Reported funding sources</legend>
              <small>
                {sourceOptions.length
                  ? 'Choose up to 20. These are provider labels, not verified provenance.'
                  : 'Refresh inventory to load reported choices, or enter one exact source.'}
              </small>
              <div className={styles.sourceChoices}>
                {[...new Set([...sourceOptions, ...selectedSources])]
                  .sort()
                  .map((value) => (
                    <label key={value}>
                      <input
                        type="checkbox"
                        checked={selectedSources.includes(value)}
                        disabled={
                          selectedSources.length >= 20 &&
                          !selectedSources.includes(value)
                        }
                        onChange={(event) => {
                          setSource('');
                          setSelectedSources((current) =>
                            event.target.checked
                              ? [...current, value]
                              : current.filter((item) => item !== value),
                          );
                        }}
                      />
                      {value}
                      {!sourceOptions.includes(value)
                        ? ' (not in latest catalog)'
                        : ''}
                    </label>
                  ))}
              </div>
              {selectedSources.length > 0 && (
                <input
                  type="hidden"
                  name="sources"
                  value={JSON.stringify(selectedSources)}
                />
              )}
            </fieldset>
            <label>
              Reported region
              <input
                name="region"
                aria-label="Reported region"
                aria-describedby={regionHelpId}
                maxLength={80}
                placeholder="One exact region or choose below"
                value={region}
                onChange={(event) => {
                  setRegion(event.target.value);
                  setSelectedRegions([]);
                }}
              />
              <small id={regionHelpId}>
                Match the reported spelling and capitalization.
              </small>
            </label>
            <fieldset className={styles.choices}>
              <legend>Reported regions</legend>
              <small>
                Choices come from the last loaded snapshot; wallet location is
                not verified. Selecting a region excludes wallets without that
                label.
              </small>
              {!regionOptions.length && (
                <small>
                  {regionsLoaded
                    ? 'No regions were reported in the last loaded snapshot.'
                    : 'Refresh inventory to load reported choices, or enter one exact region.'}
                </small>
              )}
              <div className={styles.sourceChoices}>
                {[...new Set([...regionOptions, ...selectedRegions])]
                  .sort()
                  .map((value) => (
                    <label key={value}>
                      <input
                        type="checkbox"
                        checked={selectedRegions.includes(value)}
                        disabled={
                          selectedRegions.length >= 20 &&
                          !selectedRegions.includes(value)
                        }
                        onChange={(event) => {
                          setRegion('');
                          setSelectedRegions((current) =>
                            event.target.checked
                              ? [...current, value]
                              : current.filter((item) => item !== value),
                          );
                        }}
                      />
                      {value}
                      {!regionOptions.includes(value)
                        ? ' (not in latest catalog)'
                        : ''}
                    </label>
                  ))}
              </div>
              {selectedRegions.length > 0 && (
                <input
                  type="hidden"
                  name="regions"
                  value={JSON.stringify(selectedRegions)}
                />
              )}
            </fieldset>
            <label>
              Minimum balance (SOL)
              <input
                name="minimumBalanceSol"
                inputMode="decimal"
                defaultValue="0"
                required
              />
            </label>
            <label>
              Maximum balance (SOL)
              <input
                name="maximumBalanceSol"
                inputMode="decimal"
                placeholder="No limit"
              />
            </label>
            <label>
              Maximum purchase price (SOL)
              <input
                name="maximumPriceSol"
                inputMode="decimal"
                placeholder="No limit"
              />
            </label>
            <label>
              Maximum funding age (days)
              <input
                name="maximumAgeDays"
                type="number"
                min="1"
                max="36500"
                placeholder="No limit"
              />
            </label>
            <label>
              Minimum transactions
              <input
                name="minimumTransactions"
                type="number"
                min="0"
                max={Number.MAX_SAFE_INTEGER}
                defaultValue="0"
              />
            </label>
            <label>
              Maximum transactions
              <input
                name="maximumTransactions"
                type="number"
                min="0"
                max={Number.MAX_SAFE_INTEGER}
                placeholder="No limit"
              />
            </label>
          </div>
        </details>
        <button type="submit" disabled={busy}>
          {busy ? 'Loading inventory…' : 'Refresh inventory'}
        </button>
        <button type="reset" className={styles.reset}>
          Reset filters
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {signIn && <Link href="/sign-in">Sign in to Bundle</Link>}
      {!result && !busy && !error && (
        <p>
          Refresh to check provider availability. No sample wallets are listed.
        </p>
      )}
      {result && (
        <>
          <output>
            {result.provider} · Snapshot{' '}
            {new Date(result.observedAt).toLocaleString()} ·{' '}
            {result.coverage === 'partial'
              ? 'Partial provider coverage'
              : 'Provider reports complete inventory'}
            {expired ? ' · Expired. Refresh inventory.' : ''}
          </output>
          <p>
            {result.listings.length} shown from {result.matchingCount} matching
            entries in {result.inventoryCount} provider records. Cheapest
            entries are chosen first; the funding-gap filter can reduce the
            count.
          </p>
          <div className={styles.totals}>
            <p>
              Total balance
              <strong>{marketplaceSol(result.totalBalanceLamports)} SOL</strong>
            </p>
            <p>
              Total price
              <strong>{marketplaceSol(result.totalPriceLamports)} SOL</strong>
            </p>
            <p>
              Price less balance
              <strong>{marketplaceSol(result.netCostLamports)} SOL</strong>
            </p>
          </div>
          <div className={styles.scroll}>
            <table>
              <caption>
                Provider-reported wallet inventory. Prices are indicative, not
                reserved quotes.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Wallet</th>
                  {sortHeader('balance', 'Balance')}
                  {sortHeader('price', 'Price')}
                  {sortHeader('net', 'Price less balance')}
                  <th>Source / tier</th>
                  <th scope="col">Reported region</th>
                  {sortHeader('funded', 'Funded')}
                  {sortHeader('transactions', 'Transactions')}
                </tr>
              </thead>
              <tbody>
                {displayed.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <code>{item.address}</code>
                    </td>
                    <td>{marketplaceSol(item.balanceLamports)} SOL</td>
                    <td>{marketplaceSol(item.purchasePriceLamports)} SOL</td>
                    <td>{netCost(item)} SOL</td>
                    <td>
                      {item.source}
                      <br />
                      {tierLabels[item.tier]}
                    </td>
                    <td>{item.region ?? 'Not reported'}</td>
                    <td>{new Date(item.fundedAt).toLocaleString()}</td>
                    <td>{item.transactionCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.mobileInventory}>
            <label>
              Sort displayed wallets
              <select
                value={`${sort.key}:${sort.descending ? 'desc' : 'asc'}`}
                onChange={(event) => {
                  const [key, direction] = event.target.value.split(':');
                  setSort({
                    key: key as MarketplaceSort,
                    descending: direction === 'desc',
                  });
                }}
              >
                {(
                  ['price', 'balance', 'net', 'funded', 'transactions'] as const
                ).flatMap((key) =>
                  ['asc', 'desc'].map((direction) => (
                    <option
                      key={`${key}:${direction}`}
                      value={`${key}:${direction}`}
                    >
                      {displaySortLabels[key]} ·{' '}
                      {key === 'funded'
                        ? direction === 'asc'
                          ? 'oldest first'
                          : 'newest first'
                        : direction === 'asc'
                          ? 'low to high'
                          : 'high to low'}
                    </option>
                  )),
                )}
              </select>
            </label>
            <p>
              Display order only. Selected wallets and totals stay the same.
            </p>
            <ul aria-label="Wallet inventory cards">
              {displayed.map((item) => (
                <li key={item.id}>
                  <code>{item.address}</code>
                  <dl>
                    <div>
                      <dt>Balance</dt>
                      <dd>{marketplaceSol(item.balanceLamports)} SOL</dd>
                    </div>
                    <div>
                      <dt>Price</dt>
                      <dd>{marketplaceSol(item.purchasePriceLamports)} SOL</dd>
                    </div>
                    <div>
                      <dt>Price less balance</dt>
                      <dd>{netCost(item)} SOL</dd>
                    </div>
                    <div>
                      <dt>Transactions</dt>
                      <dd>{item.transactionCount}</dd>
                    </div>
                    <div>
                      <dt>Source / tier</dt>
                      <dd>
                        {item.source} / {tierLabels[item.tier]}
                      </dd>
                    </div>
                    <div>
                      <dt>Reported region</dt>
                      <dd>{item.region ?? 'Not reported'}</dd>
                    </div>
                    <div>
                      <dt>Funded</dt>
                      <dd>{new Date(item.fundedAt).toLocaleString()}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          </div>
          {!result.listings.length && (
            <p>No entries meet these filters in this provider snapshot.</p>
          )}
        </>
      )}
      <aside className={styles.notice}>
        <h2>Before wallet acquisition</h2>
        <p>
          Funding source, age and activity are provider assertions, not
          independently verified provenance. Age and spacing do not guarantee
          privacy, quality or trading results.
        </p>
        <p>
          Purchase authorization, payment, secure delivery into your browser
          vault and recoverable order receipts are not connected. This page
          cannot purchase, import, fund or sign with a wallet.
        </p>
      </aside>
    </section>
  );
}
