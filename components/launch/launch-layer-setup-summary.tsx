import type { LaunchLayerEnvelope } from '@/lib/launch-layer-terms';
import { useId } from 'react';
import { validateLaunchPlan, launchModeLabel } from '@/lib/launch-plan';
import styles from './launch-layer-setup-summary.module.css';

function seconds(milliseconds: number) {
  const whole = Math.floor(milliseconds / 1000);
  const fraction = String(milliseconds % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return `${whole}${fraction ? '.' + fraction : ''}s`;
}

function savedPlan(envelope: LaunchLayerEnvelope) {
  try {
    const plan = validateLaunchPlan(
      JSON.parse(envelope.terms.binding.savedPlanJson),
    );
    if (
      plan.chain !== 'Solana' ||
      plan.mode !== 'Block-0' ||
      plan.launchpad !== envelope.terms.launchpad ||
      plan.currency !== envelope.terms.quote.symbol ||
      (plan.quoteAddress &&
        plan.quoteAddress !== envelope.terms.quote.address) ||
      plan.holderCount !== envelope.terms.roles.holders.length
    )
      return null;
    return plan;
  } catch {
    return null;
  }
}

/** Restates immutable layer terms, never mutable draft settings or live balances. */
export function LaunchLayerSetupSummary({
  envelope,
  contextLabel = 'Layer',
}: {
  envelope: LaunchLayerEnvelope;
  contextLabel?: string;
}) {
  const headingId = useId();
  const { roles, delays, quote, launchpad, binding } = envelope.terms;
  const plan = savedPlan(envelope);
  const tiles = [
    ['Launchpad', launchpad],
    ['Quote', quote.symbol],
    ['Mode', plan ? launchModeLabel(plan.mode) : 'Unavailable'],
    ['Preset', plan ? `${plan.preset} Build` : 'Unavailable'],
    ['Target', binding.target.kind === 'new' ? 'New token' : 'Existing token'],
    ['Funder', '1 wallet'],
    ['Developer', roles.developer ? '1 wallet' : 'No developer wallet'],
    ['Front buyers', String(roles.front.length)],
    ['Back buyers', String(roles.back.length)],
    ['Temporary holders', String(roles.temporary.length)],
    ['Final holders', String(roles.holders.length)],
    ['Funding delay', `${delays.fundingDelaySeconds}s`],
    [
      'Front to Back delay',
      roles.back.length ? seconds(delays.frontToBackDelayMs) : 'Not used',
    ],
    [
      'Back to temporary delay',
      roles.back.length && roles.temporary.length
        ? seconds(delays.backToTemporaryDelayMs)
        : 'Not used',
    ],
    [
      'Buy delay',
      plan
        ? plan.timing
          ? seconds(plan.timing.buyDelayMs)
          : '0s (none saved)'
        : 'Unavailable',
    ],
    [
      'Initial buy delay',
      plan
        ? plan.timing
          ? seconds(plan.timing.initialBuyDelayMs)
          : '0s (none saved)'
        : 'Unavailable',
    ],
  ];
  return (
    <section className={styles.summary} aria-labelledby={headingId}>
      <h5 id={headingId}>{contextLabel} configuration</h5>
      {plan ? (
        <p className={styles.token}>
          Saved name: <strong>${plan.ticker}</strong> {plan.tokenName}
        </p>
      ) : (
        <output>
          Saved launch details are unavailable. Preset and buy timings cannot be
          confirmed.
        </output>
      )}
      <dl className={styles.tiles}>
        {tiles.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p>
        Slippage, rewards and fee sharing are not confirmed by these layer
        terms.
      </p>
      <details className={styles.identity}>
        <summary>Token and quote addresses</summary>
        <dl>
          <dt>Token mint</dt>
          <dd>
            <code>{binding.target.mint}</code>
          </dd>
          <dt>Quote mint</dt>
          <dd>
            <code>{quote.address}</code>
          </dd>
        </dl>
      </details>
    </section>
  );
}
