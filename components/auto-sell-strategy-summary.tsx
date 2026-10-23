import { formatDuration, type AutoSellStrategy } from '@/lib/auto-sell';
import styles from './auto-sell-strategy-summary.module.css';

/** Current card settings only, never trade results or a new approval. */
export function AutoSellStrategySummary({
  strategy: s,
  draft = false,
}: {
  strategy: AutoSellStrategy;
  draft?: boolean;
}) {
  const amount = (value: string) =>
    value
      ? s.amountUnit === 'tokens'
        ? `${value} tokens`
        : `${value}% of supply`
      : 'Amount not set';
  let mode: string, sizing: string, trigger: string;
  if (s.mode === 'counter') {
    mode = 'Counter Trading';
    sizing = s.replicationPercent
      ? `Queues ${s.replicationPercent}% of each eligible outside buy's token amount`
      : 'Set a replication factor';
    trigger =
      s.trigger.kind === 'rate'
        ? s.trigger.percent
          ? `${s.trigger.percent}% chance per eligible outside buy`
          : 'Set the trigger probability'
        : s.trigger.kind === 'min-sol'
          ? `Outside buy of at least ${s.trigger.amount || 'Not set'} SOL`
          : `Outside buy of at least ${s.trigger.amount || 'Not set'} tokens`;
  } else if (s.mode === 'dca') {
    mode = 'DCA';
    sizing = s.dcaRandomized
      ? `${amount(s.dcaMinAmount)} to ${amount(s.dcaMaxAmount)}`
      : amount(s.dcaAmount);
    trigger =
      Number.isSafeInteger(s.dcaIntervalSeconds) && s.dcaIntervalSeconds > 0
        ? `Minimum interval: ${formatDuration(s.dcaIntervalSeconds)} (hours:minutes:seconds)`
        : 'Set a valid interval';
  } else {
    mode = 'Limit Orders';
    sizing = `${s.limitOrders.length} ${s.limitOrders.length === 1 ? 'target' : 'targets'} using ${s.amountUnit === 'tokens' ? 'token amounts' : '% of supply amounts'}`;
    const first = s.limitOrders[0];
    trigger = first
      ? first.amount && first.marketCapUsd
        ? `First target: ${amount(first.amount)} at $${first.marketCapUsd} market cap`
        : 'Set the first target amount and market cap'
      : 'Add a market-cap target';
  }
  return (
    <fieldset
      className={styles.summary}
      aria-label={`${s.name} settings summary`}
    >
      {draft && (
        <p className={styles.draft}>Draft settings: not applied to this run</p>
      )}
      <p className={styles.modeRow}>
        <strong>{mode}:</strong> <span>{sizing}</span>
      </p>
      <p>{trigger}</p>
    </fieldset>
  );
}
