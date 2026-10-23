'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import type { LaunchChain } from '@/lib/launch-plan';
import {
  readWarmupHistory,
  type HistoryResult,
  WarmupHistoryReadError,
} from '@/lib/warmup-history-client';
import { WarmupFundingTimes } from './warmup-funding-times';
import styles from './wallet-warmup.module.css';
import historyStyles from './warmup-wallet-history.module.css';

type Props = {
  chain: LaunchChain;
  addresses: string[];
  walletRevisions: Array<{ address: string; revision: number }>;
};
/** Changing chain, ordered addresses or revisions discards every prior read. */
export function WarmupWalletHistory(props: Props) {
  return <HistoryRead key={JSON.stringify(props)} {...props} />;
}
function HistoryRead({ chain, addresses, walletRevisions }: Props) {
  const [history, setHistory] = useState<HistoryResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const checkButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const deadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  function restoreFocus() {
    if (cancelButton.current && document.activeElement === cancelButton.current)
      checkButton.current?.focus({ preventScroll: true });
  }
  useEffect(
    () => () => {
      abort.current?.abort();
      if (deadline.current !== null) clearTimeout(deadline.current);
    },
    [],
  );
  function cancel() {
    restoreFocus();
    abort.current?.abort();
    abort.current = null;
    if (deadline.current !== null) clearTimeout(deadline.current);
    deadline.current = null;
    setBusy(false);
    setError('History check cancelled. You can check again when ready.');
  }
  async function inspect() {
    if (abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError('');
    setStatus(null);
    setHistory([]);
    const timeout = setTimeout(() => {
      if (abort.current !== controller) return;
      restoreFocus();
      controller.abort();
      abort.current = null;
      setBusy(false);
      setError(
        'Wallet history took too long. Check your connection and try again.',
      );
    }, 30_000);
    deadline.current = timeout;
    try {
      const result = await readWarmupHistory(
        chain,
        addresses,
        walletRevisions,
        controller.signal,
      );
      if (abort.current === controller && !controller.signal.aborted)
        setHistory(result);
    } catch (error) {
      if (abort.current === controller && !controller.signal.aborted) {
        setError(
          error instanceof WarmupHistoryReadError
            ? error.message
            : 'Wallet history unavailable. Try checking again.',
        );
        setStatus(
          error instanceof WarmupHistoryReadError ? error.status : null,
        );
      }
    } finally {
      clearTimeout(timeout);
      if (abort.current === controller) {
        restoreFocus();
        deadline.current = null;
        abort.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <details className={`${styles.options} ${historyStyles.history}`}>
      <summary>Wallet history · read only</summary>
      <p className={styles.help}>
        Applies only to the current wallet selection and revisions. Check again
        after changing wallets.
      </p>
      {chain === 'Solana' && (
        <WarmupFundingTimes
          addresses={addresses}
          walletRevisions={walletRevisions}
        />
      )}
      {error && <p role="alert">{error}</p>}
      <Button
        ref={checkButton}
        variant="outline"
        aria-disabled={busy}
        onClick={inspect}
      >
        {busy ? 'Checking activity…' : 'Check wallet history'}
      </Button>
      <output className={historyStyles.status} aria-live="polite">
        {busy
          ? 'Reading public wallet activity. This does not start warmup or request a signature.'
          : history.length > 0
            ? `History checked for ${history.length} ${history.length === 1 ? 'wallet' : 'wallets'}. Activity does not prove wallet age or readiness.`
            : 'No activity-history check for this wallet selection.'}
      </output>
      {status === 401 && <Link href="/sign-in">Sign in to check history</Link>}
      {busy && (
        <>
          <Button ref={cancelButton} variant="ghost" onClick={cancel}>
            Cancel history check
          </Button>
        </>
      )}
      {history.length > 0 && (
        <div className="warmup-history">
          {history.map((r) => (
            <article key={r.address}>
              {r.error ? (
                <output>
                  {r.address.slice(0, 4)}…{r.address.slice(-4)}: {r.error}
                </output>
              ) : (
                r.observation && (
                  <>
                    <p className={styles.historyBalance}>
                      {history.length > 1 && (
                        <span>
                          {r.address.slice(0, 4)}…{r.address.slice(-4)} ·{' '}
                        </span>
                      )}
                      {r.observation.nativeBalance} {r.observation.currency}
                    </p>
                    {r.observation.nativeBalance === '0' && (
                      <p className={styles.help}>
                        Your wallet is unfunded. You can still save and check a
                        draft.
                      </p>
                    )}
                    <details className={styles.technical}>
                      <summary>Wallet activity details</summary>
                      <p className="warmup-address">{r.address}</p>
                      <p>
                        {r.observation.nativeBalance} {r.observation.currency} ·{' '}
                        {r.observation.outgoingTransactions === null
                          ? `${r.observation.sampleCount} sampled signatures, ${r.observation.successfulSampleCount} successful`
                          : `${r.observation.outgoingTransactions} account nonce`}
                      </p>
                      <p>
                        Oldest sampled activity:{' '}
                        {r.observation.oldestObservedAt
                          ? new Date(
                              r.observation.oldestObservedAt,
                            ).toLocaleString()
                          : 'Unknown'}
                        . Wallet age: unknown.
                      </p>
                      <small>
                        {r.observation.coverage} Observed{' '}
                        {new Date(r.observation.observedAt).toLocaleString()} at
                        block/slot {r.observation.block}. Source:{' '}
                        {r.observation.source}.
                      </small>
                      <p>
                        Activity does not prove wallet age or launch
                        eligibility. Every swap needs separate approval.
                      </p>
                    </details>
                  </>
                )
              )}
            </article>
          ))}
        </div>
      )}
    </details>
  );
}
