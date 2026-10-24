'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { LaunchChain } from '@/lib/launch-plan';
import {
  readWarmupHistory,
  WarmupHistoryReadError,
} from '@/lib/warmup-history-client';
import {
  assessWarmupReadiness,
  WarmupReadinessInputError,
  WARMUP_READINESS_DISCLOSURES,
  type WarmupReadiness as Readiness,
} from '@/lib/warmup-readiness';
import { nativeUnits } from '@/lib/wallet-warmup';
import styles from './wallet-warmup.module.css';
import own from './warmup-readiness.module.css';

type Props = {
  chain: LaunchChain;
  addresses: string[];
  walletRevisions: Array<{ address: string; revision: number }>;
  feeReserve: string;
};

/**
 * Readiness is the honest half of warmup: fund and verify wallets you already
 * own. The panel performs exactly one bounded read of the existing wallet
 * endpoint and never signs, sends or schedules anything.
 *
 * Changing the chain, ordered addresses or revisions discards every prior result.
 */
export function WarmupReadiness(props: Props) {
  return (
    <ReadinessCheck
      key={JSON.stringify([
        props.chain,
        props.addresses,
        props.walletRevisions,
      ])}
      {...props}
    />
  );
}

type Balances = Array<{ address: string; nativeBalance: string | null }>;

const short = (address: string) =>
  `${address.slice(0, 4)}…${address.slice(-4)}`;

function ReadinessCheck({
  chain,
  addresses,
  feeReserve,
  walletRevisions,
}: Props) {
  const id = useId(),
    unit = nativeUnits(chain);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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

  // The requirement changes with the form's fee reserve, so recompute from the
  // balances already read instead of asking the endpoint again.
  let readiness: Readiness | null = null,
    readinessError = '';
  if (balances) {
    try {
      readiness = assessWarmupReadiness({
        chain,
        feeReserve,
        balances,
      });
    } catch (failure) {
      readinessError =
        failure instanceof WarmupReadinessInputError
          ? failure.message
          : 'Readiness unavailable for this selection.';
    }
  }

  function cancel() {
    restoreFocus();
    abort.current?.abort();
    abort.current = null;
    if (deadline.current !== null) clearTimeout(deadline.current);
    deadline.current = null;
    setBusy(false);
    setError('Readiness check cancelled. You can check again when ready.');
  }

  async function inspect() {
    if (abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError('');
    setBalances(null);
    const timeout = setTimeout(() => {
      if (abort.current !== controller) return;
      restoreFocus();
      controller.abort();
      abort.current = null;
      setBusy(false);
      setError(
        'Wallet readiness took too long. Check your connection and try again.',
      );
    }, 30_000);
    deadline.current = timeout;
    try {
      const result = await readWarmupHistory(
        chain,
        addresses,
        // Own the revision objects before the first await.
        walletRevisions.map((revision) => ({ ...revision })),
        controller.signal,
      );
      if (abort.current === controller && !controller.signal.aborted)
        setBalances(
          result.map((row) => ({
            address: row.address,
            nativeBalance: row.error
              ? null
              : (row.observation?.nativeBalance ?? null),
          })),
        );
    } catch (failure) {
      if (abort.current === controller && !controller.signal.aborted) {
        setError(
          failure instanceof WarmupHistoryReadError
            ? failure.message
            : 'Wallet readiness unavailable. Try checking again.',
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
    <section
      className={own.panel}
      aria-labelledby={`${id}-title`}
      data-warmup-readiness
    >
      <h4 id={`${id}-title`}>Wallet readiness</h4>
      <p className={styles.help}>
        Checks whether each selected wallet holds enough {unit.symbol} for your
        fee reserve
        {chain === 'Solana'
          ? ' plus the one-time rent a first token account needs'
          : ''}
        . This is a funding check, not an activity generator.
      </p>
      <ul className={own.disclosures}>
        {WARMUP_READINESS_DISCLOSURES.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {error && <p role="alert">{error}</p>}
      <div className={own.actions}>
        <Button
          ref={checkButton}
          variant="outline"
          aria-disabled={busy}
          onClick={inspect}
        >
          {busy ? 'Checking wallets…' : 'Check wallet readiness'}
        </Button>
        {busy && (
          <Button ref={cancelButton} variant="ghost" onClick={cancel}>
            Cancel readiness check
          </Button>
        )}
      </div>
      <output className={own.status} aria-live="polite">
        {busy
          ? 'Reading public balances. This does not start warmup or request a signature.'
          : readiness
            ? `${readiness.readyCount} of ${readiness.wallets.length} ready, ${readiness.fundingCount} need funding${readiness.unknownCount ? `, ${readiness.unknownCount} unknown` : ''}. Unknown reads are not counted as ready.`
            : 'No readiness check for this wallet selection.'}
      </output>
      {readinessError && <p role="alert">{readinessError}</p>}
      {readiness && (
        <>
          <dl className={own.summary}>
            <div>
              <dt>Required per wallet</dt>
              <dd>
                {readiness.perWalletRequired} {readiness.currency}
              </dd>
            </div>
            <div>
              <dt>Ready</dt>
              <dd>
                {readiness.readyCount} of {readiness.wallets.length}
              </dd>
            </div>
            <div>
              <dt>Needs funding</dt>
              <dd>{readiness.fundingCount}</dd>
            </div>
            {readiness.unknownCount > 0 && (
              <div>
                <dt>Unknown</dt>
                <dd>{readiness.unknownCount}</dd>
              </div>
            )}
            <div>
              <dt>Total shortfall</dt>
              <dd>
                {readiness.totalShortfall} {readiness.currency}
              </dd>
            </div>
          </dl>
          <p className={styles.help}>
            Requirement: {readiness.breakdown.feeReserve} {readiness.currency}{' '}
            fee reserve
            {chain === 'Solana'
              ? ` + ${readiness.breakdown.tokenAccountRent} ${readiness.currency} token-account rent`
              : ''}
            .
          </p>
          <ul className={own.wallets}>
            {readiness.wallets.map((wallet) => (
              <li key={wallet.address} data-status={wallet.status}>
                <span className={own.address}>{short(wallet.address)}</span>
                <span className={own[statusClass(wallet.status)]}>
                  {wallet.status === 'ready'
                    ? `${wallet.balance} ${readiness!.currency} · ready`
                    : wallet.status === 'needs-funding'
                      ? `Needs ${wallet.shortfall} ${readiness!.currency}`
                      : 'Balance unknown · no conclusion'}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function statusClass(status: 'ready' | 'needs-funding' | 'unknown') {
  return status === 'ready'
    ? ('ready' as const)
    : status === 'needs-funding'
      ? ('funding' as const)
      : ('unknown' as const);
}
