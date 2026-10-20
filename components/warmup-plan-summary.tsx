import { formatWarmupDelay, type WarmupPlan } from '@/lib/wallet-warmup';
import styles from './warmup-plan-summary.module.css';
export function WarmupPlanSummary({ plan }: { plan: WarmupPlan }) {
  const first = plan.actions[0].scheduledAt;
  const last = plan.actions[plan.actions.length - 1].scheduledAt;
  const totalSeconds = Math.ceil((Date.parse(last) - Date.parse(first)) / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const window =
    [
      days && `${days}d`,
      hours && `${hours}h`,
      minutes && `${minutes}m`,
      seconds && `${seconds}s`,
    ]
      .filter(Boolean)
      .join(' ') || '0s';
  return (
    <section
      className={styles.summary}
      aria-label="Warmup budget and schedule summary"
    >
      <div className={styles.heading}>
        <h4>Warmup plan</h4>
        <span>Review only</span>
      </div>
      <dl className={styles.metrics}>
        <div>
          <dt>Selected wallets</dt>
          <dd>{plan.addresses.length}</dd>
        </div>
        <div>
          <dt>Planned actions</dt>
          <dd>{plan.actions.length}</dd>
        </div>
        <div>
          <dt>
            {plan.buyAmountMax ? 'Largest wallet need' : 'Required per wallet'}
          </dt>
          <dd>
            {plan.requiredPerWallet} {plan.currency}
          </dd>
        </div>
        <div>
          <dt>Total budget</dt>
          <dd>
            {plan.totalBudget} {plan.currency}
          </dd>
        </div>
        <div>
          <dt>Cycles per wallet</dt>
          <dd>{plan.cycles}</dd>
        </div>
        <div>
          <dt>Planned window</dt>
          <dd>{window}</dd>
        </div>
      </dl>
      <p>
        {plan.buyAmountMax
          ? `Each buy: drawn between ${plan.buyAmount} and ${plan.buyAmountMax} ${plan.currency}; exact amounts are in the full schedule.`
          : `Each buy: ${plan.buyAmount} ${plan.currency}.`}{' '}
        Delay between loops: {formatWarmupDelay(plan.intervalSeconds)}.
        User-chosen fee reserve: {plan.feeReserve} {plan.currency} per wallet.
        Sell proceeds are not reused in this budget.
      </p>
      <p className={styles.schedule}>
        First buy:{' '}
        <time dateTime={first}>{new Date(first).toLocaleString()}</time>
        <br />
        Last sell:{' '}
        <time dateTime={last}>{new Date(last).toLocaleString()}</time>
      </p>
      <small>
        This window describes the planned schedule, including wallet staggering.
        Transactions require separate review and approval; execution timing and
        actual fees are unknown.
      </small>
    </section>
  );
}
