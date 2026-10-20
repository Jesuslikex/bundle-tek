'use client';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  buildWarmupPlan,
  drawWarmupAmounts,
  formatWarmupDelay,
  nativeUnits,
  estimateWarmupTotals,
  warmupDelaySeconds,
  WARMUP_MIN_DELAY_SECONDS,
  WarmupPlanInputError,
  type WarmupPlanField,
  type WarmupHistory,
  type WarmupPlan,
} from '@/lib/wallet-warmup';
import type { LaunchChain } from '@/lib/launch-plan';
import { WalletWarmupPlans } from '@/components/wallet-warmup-plans';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
import { WarmupPlanSummary } from './warmup-plan-summary';
import { readPanelJson } from './read-panel-json';
import styles from './wallet-warmup.module.css';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function revealOptions(element: HTMLElement | null) {
  let details = element?.closest('details');
  while (details) {
    details.open = true;
    details = details.parentElement?.closest('details') ?? null;
  }
}

type HistoryResult = {
  address: string;
  observation?: WarmupHistory;
  error?: string;
};
export function WalletWarmup({
  chain,
  addresses,
  walletRevisions,
  onClose,
  initialPlan,
}: {
  chain: LaunchChain;
  addresses: string[];
  walletRevisions: Array<{ address: string; revision: number }>;
  onClose: () => void;
  initialPlan?: SavedWarmup;
}) {
  const id = useId(),
    unit = nativeUnits(chain);
  const [amount, setAmount] = useState(
    initialPlan?.document.amount ?? (chain === 'Solana' ? '0.001' : '0.0001'),
  );
  const [reserve, setReserve] = useState(
    initialPlan?.document.feeReserve ?? '0.01',
  );
  const [tokens, setTokens] = useState(
    initialPlan?.document.tokens.join('\n') ?? '',
  );
  const [cycles, setCycles] = useState(
    String(initialPlan?.document.cycles ?? 3),
  );
  const [range, setRange] = useState(!!initialPlan?.document.amountMax);
  const [amountMax, setAmountMax] = useState(
    initialPlan?.document.amountMax ?? '',
  );
  const initialDelay = initialPlan
    ? warmupDelaySeconds(initialPlan.document)
    : 120 * 60;
  const [delayMinutes, setDelayMinutes] = useState(
    String(Math.floor(initialDelay / 60)),
  );
  const [delaySeconds, setDelaySeconds] = useState(String(initialDelay % 60));
  const delayTotal = Number(delayMinutes || 0) * 60 + Number(delaySeconds || 0);
  const [start, setStart] = useState(() => {
    if (!initialPlan) return '';
    const date = new Date(initialPlan.document.startAt);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  });
  const [freshStart, setFreshStart] = useState(!initialPlan);
  const panel = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const dialog = panel.current;
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    panel.current?.focus({ preventScroll: true });
    return () => dialog?.close?.();
  }, []);
  const [plan, setPlan] = useState<WarmupPlan | null>(null);
  const [error, setError] = useState('');
  const [invalidField, setInvalidField] = useState<WarmupPlanField | null>(
    null,
  );
  const fieldProps = (field: WarmupPlanField) => ({
    'data-warmup-field': field,
    'aria-invalid': invalidField === field || undefined,
    'aria-describedby':
      invalidField === field && error ? `${id}-error` : undefined,
  });
  const [history, setHistory] = useState<HistoryResult[]>([]);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const edit = (change: () => void) => {
    change();
    setPlan(null);
    setError('');
    setInvalidField(null);
  };
  async function inspect() {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError('');
    setHistory([]);
    const timeout = setTimeout(() => {
      if (controller.signal.aborted) return;
      controller.abort();
      setBusy(false);
      setError(
        'Wallet history took too long. Check your connection and try again.',
      );
    }, 30_000);
    try {
      const response = await fetch('/api/wallet-workspace/warmup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ chain, addresses }),
      });
      const data = (await readPanelJson(
        response,
        'Wallet history unavailable. Try checking again.',
      )) as {
        error?: string;
        chain?: string;
        results?: HistoryResult[];
      };
      if (!data || typeof data !== 'object')
        throw new Error('Wallet history unavailable. Try checking again.');
      if (!response.ok) throw new Error(data.error || 'History unavailable.');
      if (
        data.chain !== chain ||
        !Array.isArray(data.results) ||
        data.results.length !== addresses.length ||
        data.results.some(
          (r: HistoryResult, i: number) => r.address !== addresses[i],
        )
      )
        throw new Error('History selection mismatch.');
      if (!controller.signal.aborted) setHistory(data.results);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'History unavailable.');
    } finally {
      clearTimeout(timeout);
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function drawRangeAmounts(cycleCount: number) {
    try {
      return drawWarmupAmounts(
        amount,
        amountMax,
        unit.decimals,
        addresses.length,
        Number.isSafeInteger(cycleCount) && cycleCount > 0 ? cycleCount : 0,
      );
    } catch (e) {
      throw new WarmupPlanInputError(
        'amountMax',
        e instanceof Error ? e.message : 'Invalid range.',
      );
    }
  }
  // Live Proxima-style totals. Range mode shows the upper bound until the
  // exact amounts are drawn at review. Mirrors buildWarmupPlan's schedule.
  const estimate = useMemo(
    () =>
      estimateWarmupTotals(
        addresses.length,
        Number(cycles),
        range ? amountMax : amount,
        reserve,
        delayTotal,
        unit.decimals,
      ),
    [
      addresses.length,
      cycles,
      range,
      amount,
      amountMax,
      reserve,
      delayTotal,
      unit.decimals,
    ],
  );
  function download() {
    if (!plan) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `warmup-${chain.toLowerCase()}-plan.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <dialog
      ref={panel}
      tabIndex={-1}
      className={`wallet-warmup-panel ${styles.panel}`}
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className={styles.header}>
        <h3 id={`${id}-title`}>Generate Activity</h3>
        <Button variant="ghost" onClick={onClose}>
          Close warmup
        </Button>
      </div>
      <p className={styles.help}>
        {addresses.length} {chain}{' '}
        {addresses.length === 1 ? 'wallet' : 'wallets'} selected. Plan repeated
        buy and sell loops. Review each transaction before signing.
      </p>
      <details className={styles.options}>
        <summary>Wallet history · read only</summary>
        <Button variant="outline" disabled={busy} onClick={inspect}>
          {busy ? 'Checking activity…' : 'Check wallet history'}
        </Button>
        {busy && (
          <>
            <output aria-live="polite">
              Reading public wallet activity. This does not start warmup or
              request a signature.
            </output>
            <Button
              variant="ghost"
              onClick={() => {
                abort.current?.abort();
                setBusy(false);
                setError(
                  'History check cancelled. You can check again when ready.',
                );
              }}
            >
              Cancel history check
            </Button>
          </>
        )}
        {history.length > 0 && (
          <div className="warmup-history" aria-live="polite">
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
                          Your wallet is unfunded. You can still save and check
                          a draft.
                        </p>
                      )}
                      <details className={styles.technical}>
                        <summary>Wallet activity details</summary>
                        <p className="warmup-address">{r.address}</p>
                        <p>
                          {r.observation.nativeBalance} {r.observation.currency}{' '}
                          ·{' '}
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
                          {new Date(r.observation.observedAt).toLocaleString()}{' '}
                          at block/slot {r.observation.block}. Source:{' '}
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
      <form
        ref={form}
        tabIndex={-1}
        className={styles.setup}
        aria-label="Warmup draft setup"
        onInvalidCapture={(event) => {
          if (event.target instanceof HTMLElement) revealOptions(event.target);
        }}
        onSubmit={(e) => {
          e.preventDefault();
          try {
            const cycleCount = Number(cycles);
            setPlan(
              buildWarmupPlan({
                chain,
                addresses,
                tokens: tokens.split(/[\s,]+/).filter(Boolean),
                amount,
                ...(range
                  ? {
                      amountMax,
                      amounts: drawRangeAmounts(cycleCount),
                    }
                  : {}),
                feeReserve: reserve,
                cycles: cycleCount,
                intervalSeconds: delayTotal,
                startAt: freshStart
                  ? new Date(Date.now() + 30 * 60000).toISOString()
                  : start
                    ? new Date(start).toISOString()
                    : '',
              }),
            );
            setError('');
            setInvalidField(null);
          } catch (e) {
            setPlan(null);
            setError(e instanceof Error ? e.message : 'Invalid warmup plan.');
            setInvalidField(e instanceof WarmupPlanInputError ? e.field : null);
            if (e instanceof WarmupPlanInputError) {
              const input = form.current?.querySelector<
                HTMLInputElement | HTMLTextAreaElement
              >(`[data-warmup-field="${e.field}"]`);
              revealOptions(input ?? null);
              input?.focus();
              input?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
            }
          }
        }}
      >
        <details className={styles.options} open={!tokens || undefined}>
          <summary>
            {tokens === USDC
              ? 'Trading token · USDC'
              : tokens
                ? 'Trading tokens · custom'
                : 'Choose a trading token'}
          </summary>
          {chain === 'Solana' && (
            <div className={styles.tokenChoice}>
              <Button
                type="button"
                variant={tokens === USDC ? 'default' : 'outline'}
                aria-pressed={tokens === USDC}
                onClick={() => edit(() => setTokens(USDC))}
              >
                Use USDC
              </Button>
              <span>
                {tokens === USDC
                  ? 'USDC selected for review. No swap is requested.'
                  : 'Choose USDC or enter a custom token below.'}
              </span>
            </div>
          )}
          <details
            className={styles.options}
            open={chain !== 'Solana' ? true : undefined}
          >
            <summary>Custom token addresses</summary>
            <label>
              Token addresses, one per line
              <textarea
                {...fieldProps('tokens')}
                className="warmup-token-input"
                value={tokens}
                onChange={(e) => edit(() => setTokens(e.target.value))}
                rows={3}
                maxLength={500}
              />
            </label>
            <small>
              Up to 10 addresses. Token identity and liquidity are checked
              separately. Each sell uses its matching buy lot.
            </small>
          </details>
        </details>
        <div className={styles.amount}>
          <div className={styles.amountHead}>
            <span id={`${id}-amount-label`}>
              Amount per transaction ({unit.symbol})
              <small>Buy size for each cycle.</small>
            </span>
            <fieldset className={styles.modeToggle} aria-label="Amount mode">
              <button
                type="button"
                aria-pressed={!range}
                onClick={() => edit(() => setRange(false))}
              >
                Fixed
              </button>
              <button
                type="button"
                aria-pressed={range}
                onClick={() => edit(() => setRange(true))}
              >
                Range
              </button>
            </fieldset>
          </div>
          <div className={range ? styles.rangeInputs : undefined}>
            <Input
              id={`${id}-amount`}
              aria-labelledby={range ? undefined : `${id}-amount-label`}
              aria-label={range ? 'Minimum amount' : undefined}
              {...fieldProps('amount')}
              value={amount}
              placeholder={range ? 'Min' : '0.00'}
              onChange={(e) => edit(() => setAmount(e.target.value))}
              inputMode="decimal"
              required
            />
            {range && (
              <Input
                id={`${id}-amount-max`}
                aria-label="Maximum amount"
                {...fieldProps('amountMax')}
                value={amountMax}
                placeholder="Max"
                onChange={(e) => edit(() => setAmountMax(e.target.value))}
                inputMode="decimal"
                required
              />
            )}
          </div>
          {range && (
            <small className={styles.help}>
              Each wallet and cycle gets its own random amount in this range,
              drawn when you review. The exact amounts are shown and saved, and
              every buy still needs your approval.
            </small>
          )}
        </div>
        <div className="warmup-fields">
          <label htmlFor={`${id}-cycles`}>
            Loop count
            <Input
              id={`${id}-cycles`}
              {...fieldProps('cycles')}
              type="number"
              min={1}
              max={20}
              placeholder="1-20"
              value={cycles}
              onChange={(e) => edit(() => setCycles(e.target.value))}
              required
            />
          </label>
          <fieldset className={styles.delay}>
            <legend>Delay between loops</legend>
            <label htmlFor={`${id}-delay-min`}>
              <span className={styles.delayUnit}>Min</span>
              <Input
                id={`${id}-delay-min`}
                {...fieldProps('intervalSeconds')}
                aria-label="Delay minutes"
                type="number"
                min={0}
                max={10080}
                value={delayMinutes}
                onChange={(e) => edit(() => setDelayMinutes(e.target.value))}
              />
            </label>
            <span aria-hidden="true">:</span>
            <label htmlFor={`${id}-delay-sec`}>
              <span className={styles.delayUnit}>Sec</span>
              <Input
                id={`${id}-delay-sec`}
                aria-label="Delay seconds"
                type="number"
                min={0}
                max={59}
                value={delaySeconds}
                onChange={(e) => edit(() => setDelaySeconds(e.target.value))}
              />
            </label>
          </fieldset>
        </div>
        <small className={styles.help}>
          At least {WARMUP_MIN_DELAY_SECONDS} seconds. Each sell is planned half
          a delay after its buy.
        </small>
        <div className={styles.routingNote}>
          <strong>Direct routing</strong>
          <span>
            Uses the reviewed swap route. Alternative platform routing is not
            connected.
          </span>
        </div>
        <p className={styles.estimate} aria-live="polite">
          <span>
            {addresses.length} {addresses.length === 1 ? 'wallet' : 'wallets'}
          </span>
          <span>
            {range ? 'Required (max)' : 'Required'}:{' '}
            {estimate ? `${estimate.required} ${unit.symbol}` : 'Unavailable'}
          </span>
          <span>
            Estimated:{' '}
            {estimate ? formatWarmupDelay(estimate.seconds) : 'Unavailable'}
          </span>
        </p>
        <details className={styles.options}>
          <summary>Fee reserve and start time</summary>
          <p>
            {cycles} loops, {formatWarmupDelay(Math.max(0, delayTotal))} apart.{' '}
            {reserve} {unit.symbol} reserved per wallet. Review the complete
            budget before saving.
          </p>
          <div className="warmup-fields">
            <label htmlFor={`${id}-reserve`}>
              Fee reserve per wallet ({unit.symbol})
              <Input
                id={`${id}-reserve`}
                {...fieldProps('feeReserve')}
                value={reserve}
                onChange={(e) => edit(() => setReserve(e.target.value))}
                inputMode="decimal"
                required
              />
            </label>
            <label htmlFor={`${id}-start`}>
              Start time
              <Input
                id={`${id}-start`}
                {...fieldProps('startAt')}
                type="datetime-local"
                value={start}
                onChange={(e) =>
                  edit(() => {
                    setStart(e.target.value);
                    setFreshStart(false);
                  })
                }
                required={!freshStart}
              />
            </label>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              edit(() => {
                const date = new Date(Date.now() + 5 * 60000);
                setFreshStart(false);
                setStart(
                  new Date(date.getTime() - date.getTimezoneOffset() * 60000)
                    .toISOString()
                    .slice(0, 16),
                );
              })
            }
          >
            Start in 5 minutes
          </Button>
          <label className={styles.freshStart}>
            <input
              type="checkbox"
              checked={freshStart}
              onChange={() => edit(() => setFreshStart(!freshStart))}
            />
            Use a fresh start time, 30 minutes after review
          </label>
          {!freshStart && start && (
            <p className={styles.help}>
              A saved start time must still be in the future. Select a fresh
              start time above to refresh it, or choose a custom time in Budget
              and timing options.
            </p>
          )}
          <p className={styles.help}>
            {freshStart
              ? 'The start time is set when you click Review. Nothing is scheduled.'
              : 'The custom start time is kept until you change it.'}
          </p>
        </details>
        <p className={styles.help}>
          Saving a draft starts no trades. Every buy and sell needs your
          approval.
        </p>
        <div className={styles.reviewActions}>
          <Button type="submit">Review warmup plan</Button>
        </div>
      </form>
      {error && (
        <p id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
      {plan && <WarmupPlanSummary plan={plan} />}
      <details
        className={styles.options}
        open={!!plan || !!initialPlan || undefined}
      >
        <summary>Saved plans and recovery</summary>
        <WalletWarmupPlans
          initialPlan={initialPlan}
          chain={chain}
          addresses={addresses}
          walletRevisions={walletRevisions}
          plan={plan}
          onLoad={(doc, useFreshStart = false) => {
            setFreshStart(useFreshStart);
            setAmount(doc.amount);
            setRange(!!doc.amountMax);
            setAmountMax(doc.amountMax ?? '');
            setReserve(doc.feeReserve);
            setTokens(doc.tokens.join('\n'));
            setCycles(String(doc.cycles));
            const delay = warmupDelaySeconds(doc);
            setDelayMinutes(String(Math.floor(delay / 60)));
            setDelaySeconds(String(delay % 60));
            const date = new Date(doc.startAt);
            setStart(
              new Date(date.getTime() - date.getTimezoneOffset() * 60000)
                .toISOString()
                .slice(0, 16),
            );
            setPlan(null);
            setError('');
            setInvalidField(null);
            form.current?.focus({ preventScroll: true });
            form.current?.scrollIntoView?.({
              block: 'start',
              behavior: 'smooth',
            });
          }}
        />
      </details>
      {plan && (
        <details className={styles.technical} aria-label="Warmup plan review">
          <summary>Full schedule and export</summary>
          <h4>{plan.actions.length} planned actions</h4>
          <p>
            Buys start at fixed staggered offsets within the first quarter of
            each delay. Sells follow half a delay later. Sell proceeds do not
            reduce the budget.
          </p>
          <p>{plan.limitations}</p>
          <Button variant="outline" onClick={download}>
            Export warmup plan JSON
          </Button>
          <details>
            <summary>Inspect full schedule</summary>
            <ol className="warmup-schedule">
              {plan.actions.map((a, i) => (
                <li key={i}>
                  <strong>
                    {a.side} · cycle {a.cycle}
                  </strong>{' '}
                  · {new Date(a.scheduledAt).toLocaleString()}
                  <br />
                  <span className="warmup-address">
                    Wallet {a.address}
                    <br />
                    Token {a.token}
                  </span>
                  <br />
                  {a.amount}
                  {a.side === 'Buy' ? ` ${plan.currency}` : ''}
                </li>
              ))}
            </ol>
          </details>
        </details>
      )}
    </dialog>
  );
}
