'use client';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Clock3 } from 'lucide-react';
import Link from 'next/link';
import type { LaunchLayerEnvelope } from '@/lib/launch-layer-terms';
import {
  launchFundingRoster,
  LaunchFundingCapacityError,
  LaunchFundingReadError,
  readLaunchFundingTimes,
  type LaunchFundingComparison,
  type LaunchFundingSource,
} from '@/lib/launch-wallet-funding';
import {
  fundingGapLabel,
  type WalletFundingSelection,
} from '@/lib/wallet-funding-time';
import type { FundingOriginProgress } from '@/lib/wallet-funding-origin-client';
import styles from './launch-wallet-funding-times.module.css';
import {
  fundingHistoryNotBefore,
  noteFundingHistoryRead,
} from '@/lib/funding-history-window';

// UI-only monotonic cooldown survives keyed reviews and closing/reopening panels.
// Existing server gates remain authoritative and also cover other consumers.

const unknownFundingReasons: Record<
  NonNullable<LaunchFundingComparison['observations'][number]['reason']>,
  string
> = {
  'no-retained-receipt': 'No retained successful native SOL receipt was found.',
  'unavailable-evidence':
    'The most recently saved receipt could not establish a usable funding time.',
  'no-returned-history': 'The provider returned no transaction history.',
  'unavailable-oldest-evidence':
    'The oldest returned evidence could not be validated.',
  'unsupported-native-transaction':
    'The oldest returned transaction type is not supported by the funding history check.',
  'not-zero-to-positive-funding':
    'The oldest returned transaction does not establish an initial SOL deposit. Later transactions were not checked.',
  'unsupported-address':
    'Provider history is not available for this wallet type.',
};

function inputKey(value: unknown) {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

/** Advisory UI only: no result is supplied to planning, funding or signing. */
export function LaunchWalletFundingTimes({
  envelope,
}: {
  envelope: LaunchLayerEnvelope;
}) {
  // Key the full value, so in-place changes cannot reuse an earlier admission.
  const captured = inputKey(envelope);
  const { roster, issue } = useMemo(() => {
    try {
      return {
        roster: launchFundingRoster(
          captured === null ? null : JSON.parse(captured),
        ),
        issue: '',
      };
    } catch (error) {
      return {
        roster: null,
        issue:
          error instanceof LaunchFundingCapacityError
            ? error.message
            : 'The exact launch-wallet roster is unavailable. Reopen a current layer review before comparing funding times.',
      };
    }
  }, [captured]);
  return roster ? (
    <FundingRead key={roster.key} wallets={roster.wallets} />
  ) : (
    <output>{issue}</output>
  );
}
function FundingRead({ wallets }: { wallets: WalletFundingSelection }) {
  const sourceName = useId();
  const [source, setSource] = useState<LaunchFundingSource>('saved');
  const [result, setResult] = useState<LaunchFundingComparison | null>(null);
  const [progress, setProgress] = useState<FundingOriginProgress | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [signIn, setSignIn] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(fundingHistoryNotBefore);
  const [clock, setClock] = useState(() => performance.now());
  const providerWait = Math.max(0, Math.ceil((cooldownUntil - clock) / 1000));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const now = performance.now();
      const remaining = cooldownUntil - now;
      // Re-arm early/rounded timers; never advance the clock past the real gate.
      if (remaining > 0)
        timer = setTimeout(update, Math.max(25, Math.ceil(remaining)));
      else setClock(now);
    };
    update();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [cooldownUntil]);
  const [pairPage, setPairPage] = useState(0),
    [walletPage, setWalletPage] = useState(0);
  const active = useRef<AbortController | null>(null);
  useLayoutEffect(
    () => () => {
      active.current?.abort();
      active.current = null;
    },
    [],
  );
  const nearest = useMemo(() => {
    const map = new Map<string, LaunchFundingComparison['pairs'][number]>();
    for (const pair of result?.pairs ?? []) {
      if (!map.has(pair.a)) map.set(pair.a, pair);
      if (!map.has(pair.b)) map.set(pair.b, pair);
    }
    return map;
  }, [result]);
  function cancel() {
    if (!active.current) return;
    active.current.abort();
    active.current = null;
    setBusy(false);
    setResult(null);
    setMessage(
      `Funding comparison cancelled after ${progress?.completed ?? 0} of ${wallets.length} wallets. No partial result was kept.${source === 'provider' ? ' Wait at least 15 seconds before a new provider check; received reads may still finish.' : ''}`,
    );
  }
  function changeSource(next: LaunchFundingSource) {
    if (next === source) return;
    if (!active.current) setMessage('');
    cancel();
    setSignIn(false);
    setResult(null);
    setProgress(null);
    setPairPage(0);
    setWalletPage(0);
    setSource(next);
  }
  async function read() {
    if (active.current) return;
    if (
      source === 'provider' &&
      performance.now() < fundingHistoryNotBefore()
    ) {
      setCooldownUntil(fundingHistoryNotBefore());
      setClock(performance.now());
      setMessage('Wait for the provider cooldown before starting a new check.');
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setResult(null);
    setProgress(null);
    setMessage('');
    setSignIn(false);
    setPairPage(0);
    setWalletPage(0);
    try {
      const data = await readLaunchFundingTimes(
        wallets,
        source,
        controller.signal,
        (p) => {
          if (active.current === controller) setProgress(p);
        },
        {
          onProviderRead: () => {
            noteFundingHistoryRead();
            if (active.current === controller) {
              setCooldownUntil(fundingHistoryNotBefore());
              setClock(performance.now());
            }
          },
        },
      );
      if (active.current === controller && !controller.signal.aborted)
        setResult(data);
    } catch (error) {
      if (active.current === controller) {
        setSignIn(
          error instanceof LaunchFundingReadError && error.status === 401,
        );
        setMessage(
          error instanceof Error
            ? error.message
            : 'Launch funding history is unavailable. No partial result was kept.',
        );
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        setBusy(false);
      }
    }
  }
  const known = result?.observations.filter((w) => w.funding).length ?? 0;
  return (
    <details
      className={styles.panel}
      onToggle={(event) => {
        // Nested disclosure toggles must not cancel the still-open outer panel.
        if (!event.currentTarget.open) cancel();
      }}
    >
      <summary>
        <Clock3 aria-hidden="true" size={14} /> Assigned launch funding times ·
        read only
      </summary>
      <p>
        Compare all {wallets.length} assigned wallets, including the funder,
        developer when present, buyers and holders. This does not change the
        plan, routing, wallet roles or approval. Close this section to cancel an
        active check.
      </p>
      <fieldset className={styles.controls}>
        <legend>Funding evidence source</legend>
        <label>
          <input
            type="radio"
            name={sourceName}
            checked={source === 'saved'}
            onChange={() => changeSource('saved')}
          />{' '}
          Saved receipts
        </label>
        <label>
          <input
            type="radio"
            name={sourceName}
            checked={source === 'provider'}
            onChange={() => changeSource('provider')}
          />{' '}
          Provider history
        </label>
      </fieldset>
      <p>
        {source === 'saved'
          ? `${Math.ceil(wallets.length / 100)} saved-record request(s), with no provider history calls. Most-recently saved successful native SOL transfers only; other funding not captured in saved receipts may exist.`
          : `Up to ${Math.ceil(wallets.length / 10)} history request batches, with 17-second spacing. Each batch may perform multiple provider RPC reads. Large rosters may take many minutes. Oldest returned history can be incomplete and may not establish an initial SOL deposit. Stops on the first error; no automatic retry.`}
      </p>
      <div className={styles.controls}>
        <button
          type="button"
          disabled={busy || (source === 'provider' && providerWait > 0)}
          onClick={() => void read()}
        >
          {source === 'saved'
            ? 'Check recorded launch funding times'
            : 'Check provider launch funding times'}
        </button>
        {busy && (
          <button type="button" onClick={cancel}>
            Cancel launch funding check
          </button>
        )}
      </div>
      {source === 'provider' && providerWait > 0 && (
        <p>
          Provider history cooldown: wait up to {providerWait}s. Provider limits
          can last longer.
        </p>
      )}
      {signIn && <Link href="/sign-in">Sign in to Bundle</Link>}
      <output aria-live="polite">
        {busy
          ? `${progress?.completed ?? 0} of ${wallets.length} wallets read · ${progress?.phase === 'waiting' ? 'waiting for provider spacing' : 'reading'}.`
          : message}
      </output>
      {result && (
        <>
          <p>
            {known} known funding times · {result.observations.length - known}{' '}
            unknown · {result.pairs.length}{' '}
            {result.pairs.length === 1 ? 'pair' : 'pairs'} under 30 minutes.
            Timing similarity alone does not establish shared ownership; no
            flagged pairs does not prove wallets are unlinked. Unknown does not
            mean unfunded.
          </p>
          <p>
            Completed across {result.batches.length} check groups, not an atomic
            current-state snapshot. Each group covers up to 100 wallets; a
            provider group combines up to 10 history requests.{' '}
            {source === 'saved'
              ? 'Recorded receipt times'
              : 'Provider-reported times'}{' '}
            only; this comparison grants no funding, signing or execution
            authority.
          </p>
          {result.pairs.length > 0 && (
            <details className={styles.warning}>
              <summary>Close launch funding pairs</summary>
              <ol
                start={pairPage * 20 + 1}
                aria-label="Close launch funding pairs"
              >
                {result.pairs
                  .slice(pairPage * 20, pairPage * 20 + 20)
                  .map((pair) => (
                    <li key={`${pair.a}:${pair.b}`}>
                      <strong>{fundingGapLabel(pair.seconds)} apart</strong>
                      <code>{pair.a}</code>
                      <code>{pair.b}</code>
                    </li>
                  ))}
              </ol>
              <div className={styles.controls}>
                <button
                  type="button"
                  disabled={pairPage === 0}
                  onClick={() => setPairPage(pairPage - 1)}
                >
                  Previous funding pairs
                </button>
                <output>
                  Pairs {pairPage * 20 + 1}–
                  {Math.min(pairPage * 20 + 20, result.pairs.length)} of{' '}
                  {result.pairs.length}
                </output>
                <button
                  type="button"
                  disabled={(pairPage + 1) * 20 >= result.pairs.length}
                  onClick={() => setPairPage(pairPage + 1)}
                >
                  Next funding pairs
                </button>
              </div>
            </details>
          )}
          <details>
            <summary>All assigned wallet observations</summary>
            <ul aria-label="Launch funding observations">
              {result.observations
                .slice(walletPage * 25, walletPage * 25 + 25)
                .map((row) => {
                  const pair = nearest.get(row.address);
                  const batchIndex = result.batches.findIndex((batch) =>
                    batch.wallets.some(
                      (wallet) => wallet.address === row.address,
                    ),
                  );
                  const batch = result.batches[batchIndex];
                  return (
                    <li key={row.address}>
                      <code>{row.address}</code>
                      {row.funding ? (
                        <>
                          <span>
                            {source === 'saved'
                              ? 'Saved receipt block time'
                              : 'Oldest provider-reported funding block time'}
                            :{' '}
                            {new Date(
                              row.funding.blockTime * 1000,
                            ).toLocaleString()}{' '}
                            · slot {row.funding.slot}
                          </span>
                          {pair && (
                            <strong className={styles.warning}>
                              <Clock3 aria-hidden="true" size={13} />{' '}
                              {fundingGapLabel(pair.seconds)} apart from{' '}
                              {pair.a === row.address ? pair.b : pair.a}
                            </strong>
                          )}
                        </>
                      ) : (
                        <span>
                          Funding time unknown.{' '}
                          {row.reason
                            ? unknownFundingReasons[row.reason]
                            : 'No usable funding time was found.'}{' '}
                          {source === 'saved'
                            ? 'Other funding not captured in saved receipts may exist; this is not proof that the wallet was never funded.'
                            : 'Provider history can be incomplete; this is not proof that the wallet was never funded.'}
                        </span>
                      )}
                      {batch && (
                        <small className={styles.provenance}>
                          Funding check group {batchIndex + 1} ·{' '}
                          {source === 'saved'
                            ? 'Saved-record check'
                            : 'Latest provider capture in this group'}
                          :{' '}
                          <time dateTime={batch.capturedAt}>
                            {new Date(batch.capturedAt).toLocaleString()}
                          </time>
                          .{' '}
                          {source === 'provider' &&
                            'Individual wallet reads may be earlier. '}
                          This is a check timestamp, not the funding block time
                          or an atomic current-state snapshot.
                        </small>
                      )}
                    </li>
                  );
                })}
            </ul>
            <div className={styles.controls}>
              <button
                type="button"
                disabled={walletPage === 0}
                onClick={() => setWalletPage(walletPage - 1)}
              >
                Previous funding observations
              </button>
              <output>
                Wallets {walletPage * 25 + 1}–
                {Math.min(walletPage * 25 + 25, result.observations.length)} of{' '}
                {result.observations.length}
              </output>
              <button
                type="button"
                disabled={(walletPage + 1) * 25 >= result.observations.length}
                onClick={() => setWalletPage(walletPage + 1)}
              >
                Next funding observations
              </button>
            </div>
          </details>
        </>
      )}
    </details>
  );
}
