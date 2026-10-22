'use client';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Clock3 } from 'lucide-react';
import { readBoundedPanelJson } from '@/lib/read-bounded-panel-json';
import {
  decodeWalletFundingTimes,
  compareFundingEventTimes,
  fundingGapLabel,
  type WalletFundingSelection,
  type WalletFundingTimes,
} from '@/lib/wallet-funding-time';
import {
  readProviderFundingOrigins,
  FundingOriginClientError,
  type FundingOriginProgress,
} from '@/lib/wallet-funding-origin-client';
import type { FundingOriginBatch } from '@/lib/wallet-funding-origin-view';
import styles from './wallet-funding-proximity.module.css';
export function useWalletFundingProximity(selection: WalletFundingSelection) {
  const [source, setSource] = useState<'saved' | 'provider'>('saved');
  const key = JSON.stringify({ source, selection });
  const active = useRef<{ key: string; controller: AbortController } | null>(
    null,
  );
  const [view, setView] = useState<{
    key: string;
    busy: boolean;
    result: WalletFundingTimes | FundingOriginBatch | null;
    progress?: FundingOriginProgress;
    error: string;
  }>({ key, busy: false, result: null, error: '' });
  // Reset this component's state before painting a changed selection. Returning
  // to an earlier key must not revive that selection's old saved-record check.
  if (view.key !== key)
    setView({
      key,
      busy: false,
      result: null,
      error: view.busy
        ? `Funding check cancelled because the source or selected wallets changed. ${view.progress?.completed ?? 0} wallets were read; no partial result was kept. Wait at least 15 seconds before a new provider check; already-received reads may finish.`
        : '',
    });
  useLayoutEffect(
    () => () => {
      if (active.current?.key === key) {
        active.current.controller.abort();
        active.current = null;
      }
    },
    [key],
  );
  async function read() {
    if (
      !selection.length ||
      selection.length > 100 ||
      active.current?.key === key
    )
      return;
    active.current?.controller.abort();
    const controller = new AbortController();
    active.current = { key, controller };
    setView({ key, busy: true, result: null, error: '' });
    try {
      const captured: WalletFundingSelection = JSON.parse(key).selection;
      if (source === 'provider') {
        const result = await readProviderFundingOrigins(
          captured,
          controller.signal,
          (progress) => {
            if (active.current?.controller === controller)
              setView({ key, busy: true, result: null, error: '', progress });
          },
        );
        if (active.current?.controller === controller)
          setView({ key, busy: false, result, error: '' });
        return;
      }
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(15000),
      ]);
      const response = await fetch('/api/wallet-workspace/funding-times', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wallets: captured }),
        cache: 'no-store',
        signal,
      });
      const body = await readBoundedPanelJson(response, signal);
      signal.throwIfAborted();
      if (!response.ok) throw Error();
      const result = decodeWalletFundingTimes(body, captured);
      if (active.current?.controller === controller)
        setView({ key, busy: false, result, error: '' });
    } catch (error) {
      if (active.current?.controller === controller)
        setView({
          key,
          busy: false,
          result: null,
          error:
            source === 'provider'
              ? error instanceof FundingOriginClientError
                ? error.message
                : 'Provider funding history could not be checked. No automatic retry was made.'
              : 'Recorded funding times could not be checked. Keep the selection and retry this read.',
        });
    } finally {
      if (active.current?.controller === controller) active.current = null;
    }
  }
  function cancel() {
    if (active.current?.key !== key) return;
    active.current.controller.abort();
    active.current = null;
    setView({
      key,
      busy: false,
      result: null,
      error:
        source === 'provider'
          ? 'Provider history check cancelled. No funding was started. Wait at least 15 seconds before another provider check; already-received reads may finish.'
          : 'Funding-time check cancelled. No funding was started.',
    });
  }
  const current =
    view.key === key
      ? view
      : { key, busy: false, result: null, progress: undefined, error: '' };
  return {
    ...current,
    source,
    chooseSource(next: 'saved' | 'provider') {
      if (next === source) return;
      active.current?.controller.abort();
      active.current = null;
      setSource(next);
    },
    read,
    cancel,
    pairs: current.result
      ? compareFundingEventTimes(current.result.wallets)
      : [],
  };
}
type Check = ReturnType<typeof useWalletFundingProximity>;
export function WalletFundingProximityPanel({
  check,
  count,
}: {
  check: Check;
  count: number;
}) {
  const sourceGroup = useId();
  const startButton = useRef<HTMLButtonElement | null>(null);
  const returnFocus = useRef(false);
  useLayoutEffect(() => {
    if (!check.busy && returnFocus.current) {
      returnFocus.current = false;
      startButton.current?.focus();
    }
  }, [check.busy]);
  return (
    <section
      className={styles.panel}
      aria-label="Selected wallet funding times"
    >
      <fieldset className={styles.sources}>
        <legend>Funding evidence source</legend>
        <label>
          <input
            type="radio"
            name={sourceGroup}
            checked={check.source === 'saved'}
            onChange={() => check.chooseSource('saved')}
          />
          Saved receipts
        </label>
        <label>
          <input
            type="radio"
            name={sourceGroup}
            checked={check.source === 'provider'}
            onChange={() => check.chooseSource('provider')}
          />
          Provider history
        </label>
      </fieldset>
      <div className={styles.toolbar}>
        <button
          type="button"
          ref={startButton}
          onClick={() => void check.read()}
          disabled={check.busy || count < 1 || count > 100}
        >
          {check.source === 'saved'
            ? 'Check recorded funding times'
            : 'Check provider funding history'}
        </button>
        {check.busy && (
          <button
            type="button"
            onFocus={() => {
              returnFocus.current = true;
            }}
            onBlur={() => {
              returnFocus.current = false;
            }}
            onClick={() => {
              returnFocus.current = true;
              check.cancel();
            }}
          >
            Cancel funding-time check
          </button>
        )}
        <output>
          {check.busy
            ? check.source === 'saved'
              ? 'Reading saved receipts…'
              : check.progress
                ? `${check.progress.completed} of ${check.progress.total} wallets checked. ${check.progress.phase === 'waiting' ? 'Waiting 17 seconds before the next group.' : 'Reading provider history…'}`
                : 'Starting provider history check…'
            : check.result
              ? `${check.result.wallets.filter((w) => w.funding).length} of ${check.result.wallets.length} ${check.source === 'saved' ? 'recorded' : 'provider-reported'} times · ${check.pairs.length} ${check.pairs.length === 1 ? 'pair' : 'pairs'} under 30 minutes · ${check.result.wallets.filter((w) => !w.funding).length} unknown`
              : 'No funding-time check for this selection'}
        </output>
      </div>
      {count > 100 && (
        <p>Select up to 100 wallets for one funding-time check.</p>
      )}
      {check.source === 'provider' ? (
        <small>
          Reads the oldest transaction returned by the configured provider for
          each selected wallet. Plain native SOL funding is supported; other or
          incomplete evidence stays unknown. Earlier history may be missing.
          This uses provider quota, in groups of ten with no automatic retry.
        </small>
      ) : (
        <>
          {' '}
          <small>
            Compares the most recently saved finalized native SOL transfer to
            each selected wallet. Uses its block timestamp, not wallet creation
            time. Earlier and external funding may be missing; this is not
            first-funding history or proof of wallet ownership.
          </small>
        </>
      )}
      {check.result && (
        <small>
          {check.source === 'saved'
            ? 'Saved-record check:'
            : 'Provider history check:'}{' '}
          {new Date(check.result.capturedAt).toLocaleString()}. Click a
          wallet&apos;s clock for its{' '}
          {check.source === 'saved' ? 'recorded' : 'provider-reported'} gap.
          Timing similarity alone does not prove shared control.
        </small>
      )}
      {check.result && check.pairs.length > 0 && (
        <FundingPairReview
          key={check.key}
          pairs={check.pairs}
          source={check.source}
        />
      )}
      {check.error && <p role="alert">{check.error}</p>}
    </section>
  );
}
const FUNDING_PAIRS_PER_PAGE = 20;
function FundingPairReview({
  pairs,
  source,
}: {
  pairs: Check['pairs'];
  source: Check['source'];
}) {
  const [page, setPage] = useState(0);
  const pageStatus = useRef<HTMLOutputElement | null>(null);
  const focusStatus = useRef(false);
  const start = page * FUNDING_PAIRS_PER_PAGE;
  useLayoutEffect(() => {
    if (focusStatus.current) {
      focusStatus.current = false;
      pageStatus.current?.focus();
    }
  }, [page]);
  return (
    <details className={styles.pairReview}>
      <summary>
        <Clock3 aria-hidden="true" size={14} />
        Review {pairs.length} close funding{' '}
        {pairs.length === 1 ? 'pair' : 'pairs'}
      </summary>
      <p>
        All flagged pairs in this checked selection, including wallets on other
        table pages. Closest times first. These are{' '}
        {source === 'provider' ? 'provider-reported' : 'saved-receipt'} events;
        timing similarity alone does not prove shared control.
      </p>
      <ol start={start + 1} aria-label="Close funding pairs">
        {pairs.slice(start, start + FUNDING_PAIRS_PER_PAGE).map((pair) => (
          <li key={`${pair.a}:${pair.b}`}>
            <strong>{fundingGapLabel(pair.seconds)} apart</strong>
            <span>Wallet 1: {pair.a}</span>
            <span>Wallet 2: {pair.b}</span>
          </li>
        ))}
      </ol>
      <nav aria-label="Funding pair pages">
        <button
          type="button"
          disabled={page === 0}
          onClick={(event) => {
            focusStatus.current =
              page === 1 && document.activeElement === event.currentTarget;
            setPage((value) => value - 1);
          }}
        >
          Previous pairs
        </button>
        <output ref={pageStatus} tabIndex={-1} aria-live="polite">
          Pairs {start + 1} to{' '}
          {Math.min(start + FUNDING_PAIRS_PER_PAGE, pairs.length)} of{' '}
          {pairs.length}
        </output>
        <button
          type="button"
          disabled={start + FUNDING_PAIRS_PER_PAGE >= pairs.length}
          onClick={(event) => {
            focusStatus.current =
              start + 2 * FUNDING_PAIRS_PER_PAGE >= pairs.length &&
              document.activeElement === event.currentTarget;
            setPage((value) => value + 1);
          }}
        >
          Next pairs
        </button>
      </nav>
    </details>
  );
}
export function WalletFundingProximityBadge({
  check,
  address,
}: {
  check: Check;
  address: string;
}) {
  const row = check.result?.wallets.find((w) => w.address === address);
  if (!row) return null;
  const nearest = check.pairs.find((p) => p.a === address || p.b === address);
  const provider = check.source === 'provider';
  if (!row.funding) {
    const reasons: Record<string, string> = {
      'no-retained-receipt':
        'No retained successful native SOL receipt was found.',
      'unavailable-evidence':
        'The retained receipt could not supply a valid funding time.',
      'no-returned-history': 'The provider returned no transaction history.',
      'unavailable-oldest-evidence':
        'The oldest returned evidence could not be validated.',
      'unsupported-native-transaction':
        'This funding route is not supported by the history check yet.',
      'not-zero-to-positive-funding':
        'The oldest returned transaction does not establish an initial SOL deposit. Later transactions were not checked.',
      'unsupported-address':
        'Provider history is not available for this wallet type.',
    };
    return (
      <details className={styles.unknown}>
        <summary>
          <Clock3 aria-hidden="true" size={13} />
          Funding time unknown
        </summary>
        <p>
          {reasons[row.reason ?? ''] ?? 'No usable funding time was found.'}{' '}
          {provider
            ? 'Provider history can be incomplete.'
            : 'Earlier and external funding may be missing.'}
        </p>
      </details>
    );
  }
  const peer = nearest ? (nearest.a === address ? nearest.b : nearest.a) : null;
  return (
    <details className={nearest ? styles.warning : styles.recorded}>
      <summary>
        <Clock3 aria-hidden="true" size={13} />
        {nearest
          ? fundingGapLabel(nearest.seconds) + ' apart'
          : provider
            ? 'Provider-reported funding'
            : 'Recorded funding'}
      </summary>
      <p>
        {nearest
          ? `${provider ? 'Provider-reported' : 'Recorded'} funding events are ${fundingGapLabel(nearest.seconds)} apart from ${peer}. Below the 30-minute comparison threshold.`
          : `No pair under 30 minutes was found in these ${provider ? 'provider-reported' : 'retained'} events. This is not proof that the wallets are unlinked.`}
      </p>
      <small>
        Funding block time:{' '}
        {new Date(row.funding.blockTime * 1000).toLocaleString()} ·{' '}
        {provider ? 'provider-reported finalized' : 'saved finalized'}
        slot {row.funding.slot}. Other funding may be missing.
        {'funders' in row.funding && (
          <> · Funding sources: {row.funding.funders.join(', ')}</>
        )}
      </small>
    </details>
  );
}
