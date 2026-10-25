'use client';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Clock3 } from 'lucide-react';
import { FundingObservationReference } from './funding-observation-reference';
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
import {
  readLaunchFundingTimes,
  LaunchFundingReadError,
  type LaunchFundingComparison,
} from '@/lib/launch-wallet-funding';
import {
  fundingHistoryNotBefore,
  noteFundingHistoryRead,
} from '@/lib/funding-history-window';
import styles from './wallet-funding-proximity.module.css';
class SavedFundingSignInRequiredError extends Error {}

type BatchedResult = LaunchFundingComparison & {
  wallets: LaunchFundingComparison['observations'];
};
function batchReadError(
  error: LaunchFundingReadError,
  source: 'saved' | 'provider',
) {
  const reason =
    error.status === 401
      ? 'Sign in before checking funding history.'
      : error.status === 409
        ? 'Wallet references changed. Refresh My wallets and check again.'
        : error.status === 429
          ? `${source === 'provider' ? 'Provider history' : 'Wallet read'} rate limited; wait at least 15 seconds before a new check.`
          : error.status === 408
            ? 'History check timed out. Wait before checking again.'
            : error.status === 503
              ? source === 'provider'
                ? 'Provider history is unavailable. Try again later or choose Saved receipts.'
                : 'Saved receipt storage is unavailable. Try again later.'
              : 'Funding history could not be checked.';
  return `Funding check stopped after ${error.completed} of ${error.total} wallets. No partial result was kept. ${reason} No automatic retry was made.`;
}
export function useWalletFundingProximity(
  selection: WalletFundingSelection,
  maximumWallets: 100 | 500 = 100,
) {
  const [source, setSource] = useState<'saved' | 'provider'>('saved');
  const capacityValid = maximumWallets === 100 || maximumWallets === 500;
  const key = JSON.stringify({ source, selection, maximumWallets });
  const [cooldownUntil, setCooldownUntil] = useState(fundingHistoryNotBefore);
  const [clock, setClock] = useState(() => performance.now());
  const providerWait =
    maximumWallets === 500 && source === 'provider'
      ? Math.max(0, Math.ceil((cooldownUntil - clock) / 1000))
      : 0;
  useEffect(() => {
    if (maximumWallets !== 500) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const now = performance.now(),
        remaining = cooldownUntil - now;
      if (remaining > 0)
        timer = setTimeout(update, Math.max(25, Math.ceil(remaining)));
      else setClock(now);
    };
    update();
    return () => clearTimeout(timer);
  }, [cooldownUntil, maximumWallets]);
  const active = useRef<{ key: string; controller: AbortController } | null>(
    null,
  );
  const [view, setView] = useState<{
    key: string;
    busy: boolean;
    result: WalletFundingTimes | FundingOriginBatch | BatchedResult | null;
    progress?: FundingOriginProgress;
    needsSignIn?: boolean;
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
        ? JSON.parse(view.key).source === 'provider'
          ? `Funding check cancelled because the source or selected wallets changed. ${view.progress?.completed ?? 0} wallets were read; no partial result was kept. Wait at least 15 seconds before a new provider check; already-received reads may finish.`
          : 'Funding check cancelled because the source or selected wallets changed; no partial result was kept. No provider check was started.'
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
      selection.length > maximumWallets ||
      !capacityValid ||
      active.current?.key === key
    )
      return;
    if (
      maximumWallets === 500 &&
      source === 'provider' &&
      performance.now() < fundingHistoryNotBefore()
    ) {
      setCooldownUntil(fundingHistoryNotBefore());
      setClock(performance.now());
      return;
    }
    active.current?.controller.abort();
    const controller = new AbortController();
    active.current = { key, controller };
    setView({ key, busy: true, result: null, error: '' });
    try {
      const captured: WalletFundingSelection = JSON.parse(key).selection;
      if (maximumWallets === 500) {
        const result = await readLaunchFundingTimes(
          captured,
          source,
          controller.signal,
          (progress) => {
            if (active.current?.controller === controller)
              setView({ key, busy: true, result: null, error: '', progress });
          },
          {
            onProviderRead() {
              const until = noteFundingHistoryRead();
              if (active.current?.controller === controller) {
                setCooldownUntil(until);
                setClock(performance.now());
              }
            },
          },
        );
        if (
          active.current?.controller === controller &&
          !controller.signal.aborted
        )
          setView({
            key,
            busy: false,
            result: { ...result, wallets: result.observations },
            error: '',
          });
        return;
      }
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
      if (signal.aborted) {
        void response.body?.cancel().catch(() => {});
        signal.throwIfAborted();
      }
      if (response.status === 401) {
        void response.body?.cancel().catch(() => {});
        throw new SavedFundingSignInRequiredError();
      }
      const body = await readBoundedPanelJson(response, signal);
      signal.throwIfAborted();
      if (!response.ok) throw Error();
      const result = decodeWalletFundingTimes(body, captured);
      if (active.current?.controller === controller)
        setView({ key, busy: false, result, error: '' });
    } catch (error) {
      const needsSignIn =
        error instanceof SavedFundingSignInRequiredError ||
        ((error instanceof FundingOriginClientError ||
          error instanceof LaunchFundingReadError) &&
          error.status === 401);
      if (active.current?.controller === controller)
        setView({
          key,
          busy: false,
          result: null,
          needsSignIn,
          error:
            error instanceof SavedFundingSignInRequiredError
              ? 'Sign in before checking recorded funding times. No automatic retry was made.'
              : maximumWallets === 500 &&
                  error instanceof LaunchFundingReadError
                ? batchReadError(error, source)
                : source === 'provider'
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
    needsSignIn: Boolean(current.needsSignIn),
    source,
    maximumWallets,
    capacityValid,
    providerWait,
    chooseSource(next: 'saved' | 'provider') {
      if (next === source) return;
      active.current?.controller.abort();
      active.current = null;
      setSource(next);
    },
    read,
    cancel,
    pairs: current.result
      ? 'pairs' in current.result
        ? current.result.pairs
        : compareFundingEventTimes(current.result.wallets)
      : [],
  };
}
type Check = ReturnType<typeof useWalletFundingProximity>;
export function WalletFundingProximityPanel({
  check,
  count,
  context = 'table',
}: {
  check: Check;
  count: number;
  context?: 'table' | 'warmup' | 'roster';
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
      aria-label={
        context === 'roster'
          ? 'Matching wallet funding times'
          : 'Selected wallet funding times'
      }
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
          disabled={
            check.busy ||
            !check.capacityValid ||
            count < 1 ||
            count > check.maximumWallets ||
            check.providerWait > 0
          }
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
              : context === 'roster'
                ? 'No funding-time check for these matching wallets'
                : 'No funding-time check for this selection'}
        </output>
      </div>
      {check.providerWait > 0 && (
        <output>
          Wait up to {check.providerWait}s before another provider history
          check. Provider limits can last longer; no automatic retry.
        </output>
      )}
      {count > check.maximumWallets && (
        <p>
          {context === 'roster' ? 'Narrow the folder or search to' : 'Select'}{' '}
          up to {check.maximumWallets} wallets for one funding-time check.
        </p>
      )}
      {!check.capacityValid && (
        <p role="alert">
          This check&apos;s wallet capacity is unavailable. Reopen My wallets.
        </p>
      )}
      {check.source === 'provider' ? (
        <small>
          Reads the oldest transaction returned by the configured provider for
          each checked wallet. Plain native SOL funding is supported; other or
          incomplete evidence stays unknown. Earlier history may be missing.
          This uses provider quota, in groups of ten with no automatic retry.
          {check.maximumWallets === 500 && (
            <>
              {' '}
              Up to {Math.ceil(count / 10)} request groups, with 17-second
              spacing. Each group may perform multiple provider RPC reads. Large
              selections can take many minutes.
            </>
          )}
        </small>
      ) : (
        <>
          {' '}
          <small>
            Compares the most recently saved finalized native SOL transfer to
            each checked wallet. Uses its block timestamp, not wallet creation
            time. Earlier and external funding may be missing; this is not
            first-funding history or proof of wallet ownership.
          </small>
        </>
      )}
      {check.result && 'batches' in check.result && (
        <details className={styles.captures}>
          <summary>
            {check.result.batches.length} separate funding batches
          </summary>
          <p>
            These batches were read separately. They are not one atomic or
            current-state qualification. Timing alone does not establish shared
            ownership. Ranges follow checked-wallet order, which can differ from
            the sorted table. Provider batches contain several reads; their
            displayed time is the latest reported check time.
          </p>
          <ol>
            {check.result.batches.map((batch, index) => (
              <li key={index}>
                Batch {index + 1}, checked wallets {index * 100 + 1} to{' '}
                {index * 100 + batch.wallets.length}:{' '}
                {new Date(batch.capturedAt).toLocaleString()}
              </li>
            ))}
          </ol>
          <p>
            Click a wallet&apos;s clock for its checked gap. Missing history
            stays unknown.
          </p>
        </details>
      )}
      {check.result && 'capturedAt' in check.result && (
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
          context={context}
        />
      )}
      {check.error && <p role="alert">{check.error}</p>}
      {check.needsSignIn && (
        <p>
          <a
            href="/sign-in"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4"
          >
            Sign in to Bundle (opens a new tab)
          </a>
          . Return here, then run the funding check again. It will not restart
          automatically.
        </p>
      )}
    </section>
  );
}
const FUNDING_PAIRS_PER_PAGE = 20;
function FundingPairReview({
  pairs,
  source,
  context,
}: {
  pairs: Check['pairs'];
  source: Check['source'];
  context: 'table' | 'warmup' | 'roster';
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
        {context === 'roster'
          ? 'All flagged pairs among these checked matching wallets, including wallets on other table pages. Wallet selection is unchanged.'
          : context === 'table'
            ? 'All flagged pairs in this checked selection, including wallets on other table pages.'
            : 'All flagged pairs in these checked warmup wallets.'}{' '}
        Closest times first. These are{' '}
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
  const batchIndex =
    check.result && 'batches' in check.result
      ? check.result.batches.findIndex((batch) =>
          batch.wallets.some((wallet) => wallet.address === address),
        )
      : -1;
  const batch =
    check.result && 'batches' in check.result && batchIndex >= 0
      ? check.result.batches[batchIndex]
      : null;
  const provenance = batch && (
    <small>
      Funding batch {batchIndex + 1} ·{' '}
      {provider ? 'latest provider-reported check' : 'saved-record check'}:{' '}
      {new Date(batch.capturedAt).toLocaleString()}. This is not the funding
      block time or an atomic current-state check.
    </small>
  );
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
        {provenance}
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
      {provenance}
      <FundingObservationReference
        address={row.address}
        revision={row.revision}
        source={check.source}
        funding={row.funding}
      />
    </details>
  );
}
