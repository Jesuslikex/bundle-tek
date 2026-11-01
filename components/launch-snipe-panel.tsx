'use client';
import { useEffect, useId, useRef, useState } from 'react';
import styles from './launch/pump-launch-ui.module.css';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { readPanelJson } from '@/components/read-panel-json';
import type { LaunchPlanInput } from '@/lib/launch-plan';
import { plannedSnipeQuote, snipeDeferred } from '@/lib/launch-snipe';

const endpoint = '/api/launch/pump/organic';
const short = (key: string) => key.slice(0, 4) + '…' + key.slice(-4);

/** Whole decimal seconds/percent/SOL to an exact integer of the given unit. */
export function scaledInteger(value: string, scale: number, label: string) {
  const match = /^(\d{1,9})(?:\.(\d+))?$/.exec(value.trim());
  const places = Math.round(Math.log10(scale));
  if (!match || (match[2]?.length ?? 0) > places)
    throw new Error(`Enter ${label} with at most ${places} decimal places.`);
  return (
    Number(match[1]) * scale +
    Number((match[2] ?? '').padEnd(places, '0') || '0')
  );
}

/**
 * Manual mode Snipe (Proxima: "Start the buys saved in your plan"). The token
 * deploys with only its Dev Buy; this starts the saved holder buys afterwards.
 * Wallets and amounts come from the saved plan on the server. Snipe only
 * plans the buys: every batch is still reviewed, approved, signed in this
 * browser and sent with a separate approval in Organic holder buys below.
 */
export function LaunchSnipePanel({
  projectId,
  plan,
  onStarted,
}: {
  projectId: string;
  plan: LaunchPlanInput;
  onStarted?: () => void;
}) {
  const id = useId(),
    mounted = useRef(true);
  const [launches, setLaunches] = useState<string[]>([]),
    [launchId, setLaunchId] = useState(''),
    [mode, setMode] = useState<'Stagger' | 'Organic'>('Stagger'),
    [delayMin, setDelayMin] = useState(() =>
      String(Math.max(0.5, (plan.timing?.buyDelayMs ?? 800) / 1000)),
    ),
    [delayMax, setDelayMax] = useState('5'),
    [slippage, setSlippage] = useState('5'),
    [rent, setRent] = useState('0.004'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const deferred = snipeDeferred(plan);
  const amount = plannedSnipeQuote(plan);

  useEffect(() => {
    mounted.current = true;
    if (!deferred) return;
    void (async () => {
      try {
        const response = await fetch(
          `/api/launch/pump?projectId=${encodeURIComponent(projectId)}`,
        );
        if (!response.ok) return;
        const data = (await response.json()) as {
          launches?: {
            state?: string;
            id?: string;
            review?: { id?: string };
          }[];
        };
        const ids = (data.launches ?? [])
          .filter((l) => l.state === 'finalized')
          .map((l) => l.review?.id ?? l.id ?? '')
          .filter(Boolean);
        if (!mounted.current) return;
        setLaunches(ids);
        setLaunchId((current) => current || ids[0] || '');
      } catch {
        /* The button stays disabled without a finalized launch. */
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, [projectId, deferred]);

  if (!deferred || plan.chain !== 'Solana' || plan.launchpad !== 'PumpFun')
    return null;

  async function snipe() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const min = scaledInteger(delayMin, 1000, 'the delay');
      const max =
        mode === 'Stagger' ? min : scaledInteger(delayMax, 1000, 'the delay');
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'snipe',
          terms: {
            launchReviewId: launchId,
            mode,
            delayMinMs: min,
            delayMaxMs: max,
            slippageBps: scaledInteger(slippage, 100, 'slippage'),
            rentAllowanceRaw: String(
              scaledInteger(rent, 1_000_000_000, 'the rent allowance'),
            ),
          },
        }),
      });
      const data = (await readPanelJson(response, 'Snipe failed.')) as Record<
        string,
        unknown
      >;
      if (!response.ok)
        throw new Error(
          typeof data.error === 'string' ? data.error : 'Snipe failed.',
        );
      if (!mounted.current) return;
      setNotice(
        'Holder buys planned. Open Organic and Stagger holder buys below to review, approve and sign batch 1. Nothing has been signed or sent yet.',
      );
      onStarted?.();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby={id + '-title'}>
      <h3 id={id + '-title'}>Snipe</h3>
      <p>
        Manual mode: the launch deploys with only its Dev Buy. Snipe starts the
        holder buys saved in this plan
        {amount
          ? ` (${amount} ${plan.currency} across ${plan.holderCount} holder wallet${plan.holderCount === 1 ? '' : 's'})`
          : ''}
        . Recheck balances and the market first; Snipe does not reserve a price.
        You still review, approve and sign every batch.
      </p>
      {!amount && <p>Save a holder buy amount in the plan to use Snipe.</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <output>{notice}</output>}
      <div className={styles.limits}>
        <label>
          Deployed launch
          <select
            value={launchId}
            onChange={(e) => setLaunchId(e.target.value)}
          >
            {!launches.length && (
              <option value="">Deploy the token first</option>
            )}
            {launches.map((l) => (
              <option key={l} value={l}>
                {short(l)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Buy pacing
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as 'Stagger' | 'Organic')}
          >
            <option value="Stagger">Stagger (fixed delay)</option>
            <option value="Organic">Organic (random delay)</option>
          </select>
        </label>
        <label htmlFor={id + '-min'}>
          {mode === 'Organic' ? 'Minimum delay (s)' : 'Delay (s)'}
          <Input
            id={id + '-min'}
            value={delayMin}
            onChange={(e) => setDelayMin(e.target.value)}
          />
        </label>
        {mode === 'Organic' && (
          <label htmlFor={id + '-max'}>
            Maximum delay (s)
            <Input
              id={id + '-max'}
              value={delayMax}
              onChange={(e) => setDelayMax(e.target.value)}
            />
          </label>
        )}
        <label htmlFor={id + '-slip'}>
          Slippage per buy (%)
          <Input
            id={id + '-slip'}
            value={slippage}
            onChange={(e) => setSlippage(e.target.value)}
          />
        </label>
        <label htmlFor={id + '-rent'}>
          Rent allowance per buy (SOL)
          <Input
            id={id + '-rent'}
            value={rent}
            onChange={(e) => setRent(e.target.value)}
          />
        </label>
        <div className={styles.actions}>
          <Button
            type="button"
            disabled={busy || !launchId || !amount}
            onClick={() => void snipe()}
          >
            {busy ? 'Planning…' : 'Snipe'}
          </Button>
        </div>
      </div>
    </section>
  );
}
