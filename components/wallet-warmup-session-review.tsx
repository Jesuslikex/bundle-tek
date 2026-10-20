'use client';
import { useEffect, useRef, useState } from 'react';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
import {
  walletWarmupSessionView,
  type WalletWarmupSessionView,
} from '@/lib/wallet-warmup-session-view';
import { WARMUP_RECEIPT_SAVED } from '@/lib/warmup-receipt-events';
import {
  formatNativeBalance,
  signedBalanceAmount,
} from '@/lib/wallet-balance-format';
import { Button } from './ui/button';
import { readPanelJson } from './read-panel-json';
import styles from './wallet-warmup-session-review.module.css';

export function WalletWarmupSessionReview({ plan }: { plan: SavedWarmup }) {
  // Any saved context change discards the old response before another click can use it.
  return <SessionReview key={JSON.stringify(plan)} plan={plan} />;
}
function SessionReview({ plan }: { plan: SavedWarmup }) {
  const pending = useRef<AbortController | null>(null);
  const [view, setView] = useState<WalletWarmupSessionView | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [page, setPage] = useState(0);
  const enabled = !plan.archived && plan.document.chain === 'Solana';
  function cancel() {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setView(null);
    setMessage('Session review cancelled. No session was started.');
  }
  useEffect(() => {
    const invalidate = () => {
      pending.current?.abort();
      pending.current = null;
      setView(null);
      setBusy(false);
      setMessage('Context changed. Request a fresh session review.');
    };
    const receipt = (event: Event) => {
      if ((event as CustomEvent).detail?.planId === plan.id) invalidate();
    };
    window.addEventListener('pagehide', invalidate);
    window.addEventListener('storage', invalidate);
    window.addEventListener(WARMUP_RECEIPT_SAVED, receipt);
    return () => {
      pending.current?.abort();
      pending.current = null;
      window.removeEventListener('pagehide', invalidate);
      window.removeEventListener('storage', invalidate);
      window.removeEventListener(WARMUP_RECEIPT_SAVED, receipt);
    };
  }, [plan.id]);
  useEffect(() => {
    if (!view) return;
    const timer = setTimeout(
      () => {
        setView(null);
        setMessage('Session review expired. Request a fresh review.');
      },
      Math.max(0, view.deadline - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [view]);
  async function read() {
    if (!enabled || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setView(null);
    setBusy(true);
    setError('');
    setMessage('');
    setPage(0);
    try {
      const response = await fetch(
        '/api/wallet-workspace/warmup/session-review',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: plan.id, revision: plan.revision }),
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10000),
          ]),
        },
      );
      const data = await readPanelJson(
        response,
        'Session review unavailable. Try again.',
      );
      if (pending.current !== controller || controller.signal.aborted) return;
      if (!response.ok) {
        const text =
          data &&
          typeof data === 'object' &&
          'error' in data &&
          typeof data.error === 'string' &&
          data.error.length <= 400
            ? data.error
            : 'Session review unavailable. Try again.';
        throw new Error(text);
      }
      const result = walletWarmupSessionView(data, plan);
      if (pending.current === controller && !controller.signal.aborted)
        setView(result);
    } catch (cause) {
      if (pending.current === controller && !controller.signal.aborted)
        setError(
          cause !== null &&
            typeof cause === 'object' &&
            'name' in cause &&
            typeof cause.name === 'string' &&
            ['TimeoutError', 'AbortError'].includes(cause.name)
            ? 'Session review took too long. Try again.'
            : cause instanceof Error
              ? cause.message
              : 'Session review unavailable. Try again.',
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  const review = view?.review;
  return (
    <section
      className={styles.panel}
      aria-label="Automatic warmup session review"
      aria-busy={busy}
    >
      <h5>Automatic session review</h5>
      <p>
        Review remaining buys, receipt-linked sells and wallet budgets.
        Reviewing starts no trades. Automatic Start is not available yet; the
        per-transaction flow remains available below.
      </p>
      <div className={styles.controls}>
        <Button
          variant="outline"
          disabled={!enabled || busy}
          onClick={() => void read()}
        >
          Review automatic session
        </Button>
        {busy && (
          <Button variant="outline" onClick={cancel}>
            Cancel session review
          </Button>
        )}
        {view && (
          <Button
            variant="ghost"
            onClick={() => {
              setView(null);
              setMessage('Session review dismissed. No session was started.');
            }}
          >
            Dismiss session review
          </Button>
        )}
      </div>
      {!enabled && (
        <p>Choose an active saved Solana plan to review a session.</p>
      )}
      {busy && (
        <output>
          Reading saved plan and finalized receipts. No wallet unlock or
          signing.
        </output>
      )}
      {error && <p role="alert">{error}</p>}
      {message && <output>{message}</output>}
      {view && review && (
        <>
          <output>
            Review expires at{' '}
            {new Date(view.reviewExpiresAt).toLocaleTimeString()}. Automatic
            execution is disabled.
          </output>
          <p>
            {review.actions.length} remaining{' '}
            {review.actions.length === 1 ? 'action' : 'actions'} across{' '}
            {review.wallets.length}{' '}
            {review.wallets.length === 1 ? 'wallet' : 'wallets'}. Maximum
            further spend:{' '}
            <strong>
              {formatNativeBalance(review.totalMaximumNativeSpendLamports, 9)}{' '}
              SOL
            </strong>
            .
          </p>
          {review.originalStartAt !== review.effectiveStartAt && (
            <p>
              The schedule starts from{' '}
              {new Date(review.effectiveStartAt).toLocaleString()}. Missed
              trades are not backfilled.
            </p>
          )}
          {review.actions.length === 0 && (
            <p>
              All recorded loops are complete. No new actions or spending are
              planned.
            </p>
          )}
          <ul className={styles.wallets}>
            {review.wallets.map((wallet) => (
              <li key={wallet.wallet}>
                <code>{wallet.wallet}</code>
                <dl>
                  <div>
                    <dt>Remaining buy inputs</dt>
                    <dd>
                      {formatNativeBalance(wallet.buySpendLamports, 9)} SOL
                    </dd>
                  </div>
                  <div>
                    <dt>Remaining fee reserve</dt>
                    <dd>
                      {formatNativeBalance(
                        wallet.remainingFeeReserveLamports,
                        9,
                      )}{' '}
                      SOL
                    </dd>
                  </div>
                  <div>
                    <dt>Maximum further spend</dt>
                    <dd>
                      {formatNativeBalance(
                        wallet.maximumNativeSpendLamports,
                        9,
                      )}{' '}
                      SOL
                    </dd>
                  </div>
                </dl>
                <details>
                  <summary>Recorded costs already counted</summary>
                  <p>
                    Buy spending:{' '}
                    {formatNativeBalance(wallet.recordedBuySpendLamports, 9)}{' '}
                    SOL. Network fees:{' '}
                    {formatNativeBalance(wallet.recordedNetworkFeesLamports, 9)}{' '}
                    SOL. Recorded rent change:{' '}
                    {signedBalanceAmount(wallet.recordedRentChangeLamports, 9)}{' '}
                    SOL. These costs are not reset by this review.
                  </p>
                </details>
              </li>
            ))}
          </ul>
          {review.actions.length > 0 && (
            <details>
              <summary>Review remaining actions</summary>
              <ol className={styles.actions} start={page * 20 + 1}>
                {review.actions
                  .slice(page * 20, (page + 1) * 20)
                  .map((action) => (
                    <li key={action.id}>
                      <strong>
                        {action.side} · Cycle {action.cycle}
                      </strong>
                      <code>{action.wallet}</code>
                      <span>
                        Token: <code>{action.mint}</code>
                      </span>
                      <time dateTime={action.scheduledAt}>
                        Earliest planned time:{' '}
                        {new Date(action.scheduledAt).toLocaleString()}
                      </time>
                      {action.side === 'Buy' ? (
                        <span>
                          Input: {formatNativeBalance(action.inputLamports, 9)}{' '}
                          SOL
                        </span>
                      ) : action.source.kind === 'saved-buy' ? (
                        <span>
                          Sell remaining{' '}
                          {formatNativeBalance(
                            action.source.remainingRaw,
                            action.source.decimals,
                          )}{' '}
                          tokens from saved buy {action.source.buyReceiptId}.
                        </span>
                      ) : (
                        <span>
                          Sell only tokens acquired by this session’s matching
                          buy after its finalized receipt. Token quantity is not
                          known yet.
                        </span>
                      )}
                    </li>
                  ))}
              </ol>
              <p>
                Actions {page * 20 + 1} to{' '}
                {Math.min((page + 1) * 20, review.actions.length)} of{' '}
                {review.actions.length}.
              </p>
              <div className={styles.controls}>
                <Button
                  variant="outline"
                  disabled={page === 0}
                  onClick={() => setPage((value) => value - 1)}
                >
                  Previous actions
                </Button>
                <Button
                  variant="outline"
                  disabled={(page + 1) * 20 >= review.actions.length}
                  onClick={() => setPage((value) => value + 1)}
                >
                  Next actions
                </Button>
              </div>
            </details>
          )}
          <p>
            Future transaction fees, rent and output remain subject to fresh
            checks. Recorded costs exclude failed or external transactions. This
            review is not a signature or spending approval.
          </p>
        </>
      )}
    </section>
  );
}
