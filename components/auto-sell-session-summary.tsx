'use client';

import { rawToDecimal } from '@/lib/auto-sell';
import type { AutoSellSnapshot } from '@/lib/auto-sell-runner';
import styles from './auto-sell-session-summary.module.css';

/** Browser session counters, never a finalized receipt or balance projection. */
export function AutoSellSessionSummary({
  snapshot,
  decimals,
}: {
  snapshot: AutoSellSnapshot;
  decimals: number;
}) {
  const states = Object.values(snapshot.states);
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18 ||
    typeof snapshot.accountedRaw !== 'bigint' ||
    snapshot.accountedRaw < 0n ||
    states.length > 5 ||
    states.some(
      (state) =>
        typeof state.bufferedRaw !== 'bigint' ||
        state.bufferedRaw < 0n ||
        typeof state.inFlightRaw !== 'bigint' ||
        state.inFlightRaw < 0n ||
        !['running', 'ended', 'stopped'].includes(state.status),
    )
  ) {
    return (
      <p role="alert">
        Session counters are unavailable. Check preparation history for
        transaction outcomes.
      </p>
    );
  }
  const queued = states.reduce((sum, state) => sum + state.bufferedRaw, 0n);
  const inFlight = states.reduce((sum, state) => sum + state.inFlightRaw, 0n);
  const status = snapshot.running
    ? snapshot.paused
      ? 'Paused'
      : 'Running in this tab'
    : 'Not running';
  const pending = inFlight > 0n;
  return (
    <section className={styles.summary} aria-label="Auto Sell session counters">
      <header>
        <h3>
          {snapshot.running ? 'Current run counters' : 'Last run counters'}
        </h3>
        <p className={styles.status}>
          {status}
          {pending ? ' · transaction in progress' : ''}
        </p>
      </header>
      {!snapshot.running && (
        <output
          className={styles.status}
          aria-label="Stopped Auto Sell pending outcome"
        >
          {pending
            ? 'The run is stopped; a transaction is still in progress.'
            : 'No transaction is in progress. Check preparation history for final outcomes.'}
        </output>
      )}
      <dl>
        <div>
          <dt>Accounted tokens</dt>
          <dd>{rawToDecimal(snapshot.accountedRaw, decimals)}</dd>
        </div>
        <div>
          <dt>{snapshot.running ? 'Queued tokens' : 'Unsent tokens'}</dt>
          <dd>{rawToDecimal(queued, decimals)}</dd>
        </div>
        <div>
          <dt>In-progress tokens</dt>
          <dd>{rawToDecimal(inFlight, decimals)}</dd>
        </div>
        <div>
          <dt>Strategies ended (this run)</dt>
          <dd>
            {states.filter((state) => state.status === 'ended').length} /{' '}
            {states.length}
          </dd>
        </div>
      </dl>
      <p>
        Accounted amounts include submitted or unknown transactions, not
        finalized sales. Check preparation history for final outcomes.
      </p>
      {pending && (
        <p className={styles.notice}>
          Pause or Stop prevents new sells; it cannot reverse an already
          submitted transaction. Check preparation history before treating an
          outcome as final.
        </p>
      )}
      <details className={styles.explanation}>
        <summary>About these counters</summary>
        <p>
          Accounted amounts remain counted against session limits, including
          retained amounts from removed strategies. Queued amounts have not been
          sent; a stopped run does not resume them. In-progress amounts have no
          final outcome yet. These are not profit or wallet balances.
        </p>
        <p>
          Closing this dialog keeps the session active. Leaving, reloading,
          locking or changing project/wallet context stops the runner and resets
          this view. Check preparation history for outstanding outcomes.
        </p>
      </details>
    </section>
  );
}
