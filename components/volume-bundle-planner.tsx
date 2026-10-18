'use client';
import { useId, useState } from 'react';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import {
  decimalToRaw,
  newVolumeSeed,
  rawToDecimal,
} from '@/lib/volume-bot-plan';
import {
  planVolumeBundles,
  type VolumeBundlePlan,
} from '@/lib/volume-bundle-plan';
import { Button } from './ui/button';
import { Input } from './ui/input';
import styles from './volume-bot-panel.module.css';

const sol = (raw: string) => `${rawToDecimal(BigInt(raw), 9)} SOL`;
/** Local arithmetic only. No API, provider, vault or scheduled-runner call. */
export function VolumeBundlePlanner({
  wallets,
  locked,
}: {
  wallets: WorkspaceWallet[];
  locked: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState({
    target: '1',
    amount: '0.05',
    tips: '0.001',
    delay: '10',
    minutes: '30',
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [plan, setPlan] = useState<VolumeBundlePlan | null>(null);
  const [error, setError] = useState('');
  const eligible = wallets.filter((w) => w.chain === 'Solana' && !w.archived);
  const field = (key: keyof typeof draft, label: string) => (
    <div key={key} className={styles.form}>
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <Input
        id={`${id}-${key}`}
        inputMode={key === 'minutes' ? 'numeric' : 'decimal'}
        value={draft[key]}
        onChange={(e) =>
          setDraft((current) => ({ ...current, [key]: e.target.value }))
        }
        required
      />
    </div>
  );
  return (
    <div className={styles.workspace}>
      <p>
        One wallet buys, then sells only that buy’s output in the same block.
        Preview the schedule and total tip limit here. Running this mode is not
        available yet.
      </p>
      <form
        className={styles.form}
        onChange={() => {
          setPlan(null);
          setError('');
        }}
        onSubmit={(e) => {
          e.preventDefault();
          setPlan(null);
          setError('');
          try {
            const raw = (text: string, label: string) => {
              const value = decimalToRaw(text, 9);
              if (value === undefined || value <= 0n)
                throw new Error(
                  `Enter ${label} in SOL with up to nine decimals.`,
                );
              return value.toString();
            };
            if (locked) throw new Error('This project is locked.');
            const delayMs = decimalToRaw(draft.delay, 3);
            if (delayMs === undefined || delayMs > 600_000n)
              throw new Error('Enter a delay from 1 to 600 seconds.');
            if (!/^[1-9]\d{0,3}$/.test(draft.minutes))
              throw new Error('Enter whole minutes from 1 to 1440.');
            if (
              selected.some(
                (w) => !eligible.some((wallet) => wallet.address === w),
              )
            )
              throw new Error(
                'Wallet selection changed. Choose current wallets again.',
              );
            setPlan(
              planVolumeBundles(
                {
                  targetVolumeLamports: raw(draft.target, 'a target'),
                  buyLamports: raw(draft.amount, 'a buy amount'),
                  tipBudgetLamports: raw(draft.tips, 'a session tip budget'),
                  durationSeconds: Number(draft.minutes) * 60,
                  delayMinMs: Number(delayMs),
                  delayMaxMs: Number(delayMs),
                  wallets: selected,
                },
                newVolumeSeed(),
              ),
            );
          } catch (caught) {
            setError((caught as Error).message);
          }
        }}
      >
        {field('target', 'Volume target (SOL)')}
        {field('amount', 'Buy amount per bundle (SOL)')}
        {field('tips', 'Total session tip limit (SOL)')}
        <p className={styles.note}>
          A maximum across every bundle, not a tip per trade. Network fees, rent
          and swap losses are separate. Nothing is reserved or spent by this
          preview.
        </p>
        <details className={styles.settings}>
          <summary>Timing</summary>
          {field('minutes', 'Session length (minutes)')}
          {field('delay', 'Delay between bundles (seconds)')}
        </details>
        <fieldset disabled={locked} className={styles.wallets}>
          <legend>Wallets</legend>
          {!eligible.length && (
            <p>Add a Solana wallet in Wallets, then return here.</p>
          )}
          {eligible.map((w) => (
            <label key={w.address}>
              <input
                type="checkbox"
                checked={selected.includes(w.address)}
                onChange={(e) =>
                  setSelected((current) =>
                    e.target.checked
                      ? [...current, w.address]
                      : current.filter((a) => a !== w.address),
                  )
                }
              />{' '}
              {w.label || `${w.address.slice(0, 4)}…${w.address.slice(-4)}`}
            </label>
          ))}
        </fieldset>
        <Button type="submit" disabled={locked || !eligible.length}>
          Preview bundle budget
        </Button>
      </form>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {plan && (
        <section aria-label="Bundle budget preview" className={styles.card}>
          <h4>Bundle budget preview</h4>
          <dl>
            <dt>Round trips</dt>
            <dd>
              {plan.estimate.bundles} bundles, {plan.estimate.trades} trades
            </dd>
            <dt>Nominal volume</dt>
            <dd>{sol(plan.estimate.nominalVolumeLamports)}</dd>
            <dt>Total tip limit</dt>
            <dd>{sol(plan.estimate.tipBudgetLamports)}</dd>
            <dt>Tip cap per bundle</dt>
            <dd>{sol(plan.rounds[0].tipCapLamports)}</dd>
            <dt>Unallocated tips</dt>
            <dd>{sol(plan.estimate.unallocatedTipLamports)}</dd>
            <dt>Estimated network fees</dt>
            <dd>~{sol(plan.estimate.networkFeesLamports)}</dd>
          </dl>
          <p className={styles.note}>
            Volume counts the buy amount twice. Sell proceeds, actual volume,
            funding needs and total costs are unknown until routes and both legs
            are simulated. Timing is a minimum schedule, not a completion
            promise.
          </p>
          <details>
            <summary>What remains before running</summary>
            <p>
              Network fees assume 0.00005 SOL per swap and 0.000005 SOL for a
              separate tip transaction. These estimates do not include rent or
              swap losses and are not a funding quote.
            </p>
            <p>
              Both legs must be built together, independently checked and
              simulated with exact buy output. Durable session reservations,
              explicit approval, bundle submission and verified settlement
              accounting are still required. This preview contains no
              transactions and cannot be saved as a running session.
            </p>
          </details>
        </section>
      )}
    </div>
  );
}
