'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  marketplaceResult,
  marketplaceFilters,
  marketplaceLamports,
  marketplaceSol,
  type MarketplaceResult,
} from '@/lib/marketplace-catalog';
import styles from './marketplace-panel.module.css';

export function MarketplacePanel() {
  const [result, setResult] = useState<MarketplaceResult | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [signIn, setSignIn] = useState(false),
    [expired, setExpired] = useState(false);
  const pending = useRef<AbortController | null>(null);
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
      if (!parsed.success)
        throw new Error(
          'Check your filter ranges. Maximum values must be at or above their minimums.',
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
        onReset={invalidate}
        className={styles.filters}
      >
        <label>
          Wallet count
          <select name="count" defaultValue="25">
            {[25, 50, 100, 200].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
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
            <label>
              History tier
              <select name="tier" defaultValue="">
                <option value="">All tiers</option>
                <option value="funding-only">Funding only</option>
                <option value="light-history">Light history</option>
                <option value="established">Established</option>
              </select>
            </label>
            <label>
              Funding source
              <input name="source" maxLength={80} placeholder="Any source" />
            </label>
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
                  <th>Wallet</th>
                  <th>Balance</th>
                  <th>Price</th>
                  <th>Source / tier</th>
                  <th>Funded</th>
                  <th>Transactions</th>
                </tr>
              </thead>
              <tbody>
                {result.listings.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <code>{item.address}</code>
                    </td>
                    <td>{marketplaceSol(item.balanceLamports)} SOL</td>
                    <td>{marketplaceSol(item.purchasePriceLamports)} SOL</td>
                    <td>
                      {item.source}
                      <br />
                      {item.tier}
                    </td>
                    <td>{new Date(item.fundedAt).toLocaleString()}</td>
                    <td>{item.transactionCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
