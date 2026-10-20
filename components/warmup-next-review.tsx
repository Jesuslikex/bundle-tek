'use client';
import type { WarmupCycleProgress } from '@/lib/warmup-cycle-progress';
import { Button } from './ui/button';
import styles from './warmup-next-review.module.css';
type Step = WarmupCycleProgress['steps'][number];
/** Navigation over admitted recorded progress, never transaction or scheduling authority. */
export function WarmupNextReview({
  progress,
  onReview,
  onRecover,
}: {
  progress: WarmupCycleProgress;
  onReview?: (step: Step) => void;
  onRecover?: (wallet: string) => void;
}) {
  const recovery = progress.steps.find((step) => step.recoveryCount > 0);
  const next =
    progress.activeApprovals > 0 || recovery
      ? undefined
      : (progress.steps.find((step) => step.state === 'Tokens remaining') ??
        progress.steps.find((step) => step.state === 'Not bought'));
  return (
    <section
      className={styles.summary}
      aria-label="Continue recorded warmup activity"
    >
      <h5>Continue recorded activity</h5>
      {recovery || progress.activeApprovals > 0 ? (
        <>
          <p>
            Start with approval recovery. Do not replace a transaction with an
            unknown outcome.
          </p>
          {recovery && (
            <>
              <code>{recovery.wallet}</code>
              {onRecover && (
                <Button
                  variant="outline"
                  onClick={() => onRecover(recovery.wallet)}
                >
                  Recover wallet approval
                </Button>
              )}
            </>
          )}
        </>
      ) : next ? (
        <>
          <p>
            Cycle {next.cycle}:{' '}
            {next.state === 'Tokens remaining'
              ? 'remaining recorded buy lots are available for sell review.'
              : 'no finalized buy is included in this revision scope for this wallet and cycle.'}
          </p>
          <code>{next.wallet}</code>
          {onReview ? (
            <Button variant="outline" onClick={() => onReview(next)}>
              {next.state === 'Tokens remaining'
                ? 'Review next sell'
                : 'Review next buy'}
            </Button>
          ) : (
            <p>
              {progress.archived
                ? 'Restore this archived plan before opening a new transaction review. Approval recovery remains available.'
                : 'New transaction review requires an active Solana plan and its selected wallets.'}
            </p>
          )}
        </>
      ) : (
        <p>
          All included recorded buy lots are sold. This does not prove profit,
          current balances or wallet readiness.
        </p>
      )}
      <small>
        Recorded receipts only. This is a review shortcut, not a scheduled
        action. Opening it does not approve, sign or send a transaction.
      </small>
    </section>
  );
}
