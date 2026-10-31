'use client';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  buildWarmupPlan,
  drawWarmupAmounts,
  drawWarmupOrganic,
  formatWarmupDelay,
  nativeUnits,
  estimateWarmupTotals,
  warmupDelaySeconds,
  warmupOrganicTerms,
  WARMUP_HARD_MAX_DELAY_SECONDS,
  WARMUP_MIN_DELAY_SECONDS,
  WARMUP_ORGANIC_LIMITS,
  WarmupPlanInputError,
  warmupSuggestedReserve,
  type WarmupPlanField,
  type WarmupPlan,
  type WarmupOrganicTerms,
  type WarmupPlatform,
  type WarmupSchedule,
} from '@/lib/wallet-warmup';
import type { LaunchChain } from '@/lib/launch-plan';
import { WARMUP_MAX_CYCLES } from '@/lib/warmup-history-capacity';
import { WalletWarmupPlans } from '@/components/wallet-warmup-plans';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
import { WarmupPlanSummary } from './warmup-plan-summary';
import { WarmupReadiness } from './warmup-readiness';
import { WarmupWalletHistory } from './warmup-wallet-history';
import { WarmupExecutionInventory } from './warmup-execution-inventory';
import styles from './wallet-warmup.module.css';
import { ChevronDown, Clock, Wallet } from 'lucide-react';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function short(address: string) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function revealOptions(element: HTMLElement | null) {
  let details = element?.closest('details');
  while (details) {
    details.open = true;
    details = details.parentElement?.closest('details') ?? null;
  }
}

export function WalletWarmup({
  chain,
  addresses,
  walletRevisions,
  onClose,
  initialPlan,
  roster,
  onSelect,
}: {
  chain: LaunchChain;
  addresses: string[];
  walletRevisions: Array<{ address: string; revision: number }>;
  onClose: () => void;
  initialPlan?: SavedWarmup;
  roster?: Array<{ address: string; label: string }>;
  onSelect?: (addresses: string[]) => void;
}) {
  const id = useId(),
    unit = nativeUnits(chain);
  // Proxima's Generate Activity form: volume target, duration, transactions per
  // day and max loss per wallet. Cycles and the delay are derived from those,
  // because the engine underneath still schedules fixed cycles.
  const [volumeTarget, setVolumeTarget] = useState(() => {
    const doc = initialPlan?.document;
    if (!doc) return '';
    const per = Number(doc.amountMax ?? doc.amount);
    if (!Number.isFinite(per)) return String(doc.amountMax ?? doc.amount);
    return String(per * Math.max(1, doc.cycles) * Math.max(1, addresses.length));
  });
  const [durationHours, setDurationHours] = useState(
    initialPlan
      ? String(
          Math.max(
            1,
            Math.round(
              (initialPlan.document.cycles *
                warmupDelaySeconds(initialPlan.document)) /
                3600,
            ),
          ),
        )
      : '6',
  );
  const [txMin, setTxMin] = useState(() => {
    const doc = initialPlan?.document;
    if (!doc) return '20';
    const delay = Math.max(1, warmupDelaySeconds(doc));
    return String(Math.max(1, Math.round(86400 / delay)));
  });
  const [txMax, setTxMax] = useState(() => {
    const doc = initialPlan?.document;
    if (!doc) return '40';
    const delay = Math.max(1, warmupDelaySeconds(doc));
    return String(Math.max(1, Math.round(86400 / delay)));
  });
  const [lossOn, setLossOn] = useState(!!initialPlan?.document.feeReserve);
  const [maxLoss, setMaxLoss] = useState(
    initialPlan?.document.feeReserve ?? '',
  );
  const reserve = lossOn && maxLoss ? maxLoss : '0.01';
  const txMid = (Number(txMin || 0) + Number(txMax || 0)) / 2;
  const delayTotal = txMid > 0
    ? Math.min(
        WARMUP_HARD_MAX_DELAY_SECONDS,
        Math.max(WARMUP_MIN_DELAY_SECONDS, Math.round(86400 / txMid)),
      )
    : WARMUP_MIN_DELAY_SECONDS;
  const cycles = String(
    Math.min(
      WARMUP_MAX_CYCLES,
      Math.max(
        1,
        Math.round((Number(durationHours || 0) * 3600) / Math.max(1, delayTotal)),
      ),
    ),
  );
  const amount = useMemo(() => {
    const target = Number(volumeTarget);
    const wallets = addresses.length;
    const count = Number(cycles);
    if (!Number.isFinite(target) || target <= 0 || !wallets || !count) return '';
    const per = target / (wallets * count);
    const fixed = per.toFixed(unit.decimals);
    return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  }, [volumeTarget, addresses.length, cycles, unit.decimals]);
  // Alternative routing is shown like Proxima's but cannot be turned on:
  // Axiom has no public route Bundle's browser-held keys can use, so every
  // plan is saved with the direct route and no extra routing fee.
  const platform: WarmupPlatform = 'none';
  const [schedule, setSchedule] = useState<WarmupSchedule>(
    initialPlan?.document.schedule ?? 'staggered',
  );
  const [organicMode, setOrganicMode] = useState(
    !!initialPlan?.document.organicTerms,
  );
  const [organicJitter, setOrganicJitter] = useState(
    String(initialPlan?.document.organicTerms?.jitterPercent ?? 30),
  );
  const [organicHoldMin, setOrganicHoldMin] = useState(
    String(initialPlan?.document.organicTerms?.holdMinSeconds ?? 60),
  );
  const [organicHoldMax, setOrganicHoldMax] = useState(
    String(initialPlan?.document.organicTerms?.holdMaxSeconds ?? 600),
  );
  const [organicSkip, setOrganicSkip] = useState(
    String(initialPlan?.document.organicTerms?.skipPercent ?? 25),
  );
  const [organicRandomTokens, setOrganicRandomTokens] = useState(
    initialPlan?.document.organicTerms?.randomTokens ?? true,
  );
  const [picker, setPicker] = useState(false);
  const [tokens, setTokens] = useState(
    initialPlan?.document.tokens.join('\n') ?? (chain === 'Solana' ? USDC : ''),
  );
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
  const edit = (change: () => void) => {
    change();
    setPlan(null);
    setError('');
    setInvalidField(null);
  };
  function drawRangeAmounts(cycleCount: number) {
    try {
      return drawWarmupAmounts(
        amount,
        amount,
        unit.decimals,
        addresses.length,
        Number.isSafeInteger(cycleCount) && cycleCount > 0 ? cycleCount : 0,
      );
    } catch (e) {
      throw new WarmupPlanInputError(
        'amount',
        e instanceof Error ? e.message : 'Invalid amount.',
      );
    }
  }
  void drawRangeAmounts;
  // Live totals, mirroring buildWarmupPlan's schedule.
  const estimate = useMemo(
    () =>
      estimateWarmupTotals(
        addresses.length,
        Number(cycles),
        amount,
        reserve,
        delayTotal,
        unit.decimals,
        schedule,
        platform,
      ),
    [
      addresses.length,
      cycles,
      amount,
      reserve,
      delayTotal,
      unit.decimals,
      schedule,
      platform,
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
        <h3 id={`${id}-title`}>Wallet warmup</h3>
        <Button variant="ghost" onClick={onClose}>
          Close warmup
        </Button>
      </div>
      <p className={styles.help}>
        {addresses.length} {chain}{' '}
        {addresses.length === 1 ? 'wallet' : 'wallets'} selected. Check funding
        and readiness below. Any activity you sign is self-generated by one
        operator, publicly visible on-chain, and does not make these wallets
        independent, aged or organic.
      </p>
      <WarmupReadiness
        chain={chain}
        addresses={addresses}
        walletRevisions={walletRevisions}
        feeReserve={reserve}
      />
      <WarmupWalletHistory
        chain={chain}
        addresses={addresses}
        walletRevisions={walletRevisions}
      />
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
            const tokenList = tokens.split(/[\s,]+/).filter(Boolean);
            // Organic draws happen once, here at review, and are saved on the
            // plan so every rebuild reproduces the exact reviewed schedule.
            const organicTerms: WarmupOrganicTerms | undefined = organicMode
              ? warmupOrganicTerms({
                  jitterPercent: Number(organicJitter),
                  holdMinSeconds: Number(organicHoldMin),
                  holdMaxSeconds: Number(organicHoldMax),
                  skipPercent: Number(organicSkip),
                  randomTokens: organicRandomTokens,
                })
              : undefined;
            setPlan(
              buildWarmupPlan({
                chain,
                addresses,
                tokens: tokenList,
                amount,
                feeReserve: reserve,
                platform,
                schedule,
                ...(organicTerms
                  ? {
                      organicTerms,
                      organic: drawWarmupOrganic(
                        organicTerms,
                        addresses.length,
                        cycleCount,
                        tokenList.length,
                        delayTotal,
                      ),
                    }
                  : {}),
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
        <p className={styles.help} data-warmup-activity-notice>
          The loop plan below records self-generated activity. It does not
          create organic volume, and it cannot make coordinated wallets appear
          independent to anyone reading the chain. Readiness above is the part
          that prepares wallets; every swap still needs its own approval.
        </p>
        <div className={styles.field}>
          <p className={styles.fieldLabel}>Wallets</p>
          <button
            type="button"
            className={styles.walletPicker}
            onClick={() => setPicker(true)}
          >
            <Wallet size={13} />
            <span>
              {addresses.length === 0
                ? 'Select wallets'
                : `${addresses.length} wallet${addresses.length === 1 ? '' : 's'} selected`}
            </span>
            <ChevronDown size={10} className={styles.walletPickerChevron} />
          </button>
        </div>
        {picker && (
          <div className={styles.backdrop}>
            <div
              className={styles.picker}
              role="dialog"
              aria-modal="true"
              aria-label="Select Wallets"
              tabIndex={-1}
              ref={(node) => node?.focus()}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setPicker(false);
              }}
            >
              <div className={styles.pickerHead}>
                <p>Select Wallets</p>
                <Button type="button" size="sm" onClick={() => setPicker(false)}>
                  Done
                </Button>
              </div>
              <p className={styles.help}>Select the wallets to put to work.</p>
              <div className={styles.pickerList}>
                {(roster ?? []).length ? (
                  (roster ?? []).map((w) => (
                    <label key={w.address}>
                      <input
                        type="checkbox"
                        checked={addresses.includes(w.address)}
                        onChange={(e) =>
                          edit(() =>
                            onSelect?.(
                              e.target.checked
                                ? [...addresses, w.address]
                                : addresses.filter((a) => a !== w.address),
                            ),
                          )
                        }
                      />{' '}
                      {w.label || short(w.address)}
                    </label>
                  ))
                ) : (
                  <p>No active Solana wallets.</p>
                )}
              </div>
            </div>
          </div>
        )}
        {addresses.length === 0 && (
          <div className={styles.empty}>
            <Wallet size={16} />
            <p>Select the wallets to put to work.</p>
          </div>
        )}
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
        <div className={styles.field}>
          <p className={styles.fieldLabel}>
            Volume target
            <span
              className={styles.helpIcon}
              title="Buys are sized to reach it over the duration, and the activity stops once every chain has reached its own."
              aria-label="Buys are sized to reach it over the duration, and the activity stops once every chain has reached its own."
            >
              ?
            </span>
          </p>
          <div className={styles.currency}>
            <span className={styles.currencyLead} aria-hidden="true">
              <Wallet size={12} />
            </span>
            <Input
              id={`${id}-volume`}
              aria-label={`Volume target in ${unit.symbol}`}
              {...fieldProps('amount')}
              value={volumeTarget}
              placeholder="0.00"
              onChange={(e) => edit(() => setVolumeTarget(e.target.value))}
              inputMode="decimal"
              required
            />
            <span className={styles.currencySide}>{unit.symbol}</span>
          </div>
          <small className={styles.help}>
            {amount
              ? `${amount} ${unit.symbol} per transaction across ${addresses.length} wallet${addresses.length === 1 ? '' : 's'}.`
              : 'Buys are sized to reach it over the duration, and the activity stops once every chain has reached its own.'}
          </small>
        </div>
        <div className="warmup-fields">
          <label htmlFor={`${id}-duration`}>
            Duration
            <Input
              id={`${id}-duration`}
              {...fieldProps('cycles')}
              type="number"
              min={1}
              max={168}
              placeholder="6"
              value={durationHours}
              onChange={(e) => edit(() => setDurationHours(e.target.value))}
              required
            />
            <span className={styles.delayUnit}>hours</span>
          </label>
          <fieldset className={styles.delay}>
            <legend>Transactions per day</legend>
            <label htmlFor={`${id}-tx-min`}>
              <span className={styles.delayUnit}>Min</span>
              <Input
                id={`${id}-tx-min`}
                {...fieldProps('intervalSeconds')}
                aria-label="Minimum transactions per day"
                type="number"
                min={1}
                max={86400}
                placeholder="20"
                value={txMin}
                onChange={(e) => edit(() => setTxMin(e.target.value))}
              />
              <span className={styles.delayUnit}>tx</span>
            </label>
            <span aria-hidden="true">–</span>
            <label htmlFor={`${id}-tx-max`}>
              <span className={styles.delayUnit}>Max</span>
              <Input
                id={`${id}-tx-max`}
                aria-label="Maximum transactions per day"
                type="number"
                min={1}
                max={86400}
                placeholder="40"
                value={txMax}
                onChange={(e) => edit(() => setTxMax(e.target.value))}
              />
              <span className={styles.delayUnit}>tx</span>
            </label>
          </fieldset>
        </div>
        <small className={styles.help}>
          {cycles} loops per wallet, about {formatWarmupDelay(delayTotal)} apart
          (minimum {WARMUP_MIN_DELAY_SECONDS} second{WARMUP_MIN_DELAY_SECONDS === 1 ? '' : 's'}).{' '}
          {organicMode
            ? 'Organic timing jitters each wallet around this beat instead of selling half a delay later.'
            : 'Each sell is planned half a delay after its buy.'}
        </small>
        <div className={styles.field}>
          <div className={styles.lossHead}>
            <label className={styles.fieldLabel} htmlFor={`${id}-max-loss`}>
              Max loss per wallet
              <span
                className={styles.helpIcon}
                title="The most a wallet can lose there to gas, fees and swap costs."
                aria-label="The most a wallet can lose there to gas, fees and swap costs."
              >
                ?
              </span>
            </label>
            <button
              type="button"
              role="switch"
              aria-checked={lossOn}
              aria-label="Cap the loss per wallet"
              className={`${styles.switch} ${lossOn ? styles.switchOn : ''}`}
              onClick={() => edit(() => setLossOn(!lossOn))}
            >
              <span />
            </button>
          </div>
          {lossOn && (
            <div className={styles.currency}>
              <Input
                id={`${id}-max-loss`}
                aria-label={`Max loss per wallet in ${unit.symbol}`}
                {...fieldProps('feeReserve')}
                value={maxLoss}
                placeholder="No limit"
                onChange={(e) => edit(() => setMaxLoss(e.target.value))}
                inputMode="decimal"
                required
              />
              <span className={styles.currencySide}>{unit.symbol}</span>
            </div>
          )}
          <small className={styles.help}>
            The most a wallet can lose there to gas, fees and swap costs.
          </small>
        </div>
        <fieldset className={styles.routingNote} aria-label="Timing mode">
          <legend>Timing</legend>
          <label>
            <input
              type="radio"
              name={`${id}-timing`}
              value="fixed"
              checked={!organicMode}
              onChange={() => edit(() => setOrganicMode(false))}
            />
            Fixed beat, every wallet on the same rhythm
          </label>
          <label>
            <input
              type="radio"
              name={`${id}-timing`}
              value="organic"
              checked={organicMode}
              onChange={() => edit(() => setOrganicMode(true))}
            />
            Organic, jittered cadence, holds and skipped loops
          </label>
          {organicMode && (
            <>
              <div className="warmup-fields">
                <label htmlFor={`${id}-organic-jitter`}>
                  Cadence jitter (%)
                  <Input
                    id={`${id}-organic-jitter`}
                    {...fieldProps('organic')}
                    aria-label="Cadence jitter percent"
                    type="number"
                    min={0}
                    max={WARMUP_ORGANIC_LIMITS.maxJitterPercent}
                    value={organicJitter}
                    onChange={(e) => edit(() => setOrganicJitter(e.target.value))}
                  />
                </label>
                <label htmlFor={`${id}-organic-skip`}>
                  Skip chance (%)
                  <Input
                    id={`${id}-organic-skip`}
                    aria-label="Skip chance percent"
                    type="number"
                    min={0}
                    max={WARMUP_ORGANIC_LIMITS.maxSkipPercent}
                    value={organicSkip}
                    onChange={(e) => edit(() => setOrganicSkip(e.target.value))}
                  />
                </label>
              </div>
              <div className="warmup-fields">
                <label htmlFor={`${id}-organic-hold-min`}>
                  Shortest hold (sec)
                  <Input
                    id={`${id}-organic-hold-min`}
                    aria-label="Shortest hold in seconds"
                    type="number"
                    min={WARMUP_ORGANIC_LIMITS.minHoldSeconds}
                    value={organicHoldMin}
                    onChange={(e) => edit(() => setOrganicHoldMin(e.target.value))}
                  />
                </label>
                <label htmlFor={`${id}-organic-hold-max`}>
                  Longest hold (sec)
                  <Input
                    id={`${id}-organic-hold-max`}
                    aria-label="Longest hold in seconds"
                    type="number"
                    min={WARMUP_ORGANIC_LIMITS.minHoldSeconds}
                    value={organicHoldMax}
                    onChange={(e) => edit(() => setOrganicHoldMax(e.target.value))}
                  />
                </label>
              </div>
              <label className={styles.freshStart}>
                <input
                  type="checkbox"
                  checked={organicRandomTokens}
                  onChange={() => edit(() => setOrganicRandomTokens(!organicRandomTokens))}
                />
                Pick tokens at random instead of in order
              </label>
              <span>
                Cadence, holds, token order and skipped loops are drawn once when
                you review and saved with the plan. The first loop of every wallet
                is always kept, skipped loops drop out of the budget, and the
                longest hold must fit inside the delay. This disguises the
                activity; it does not make the wallets independent.
              </span>
            </>
          )}
        </fieldset>
        <fieldset className={styles.routingNote}>
          <legend>Routing and order</legend>
          <label className={styles.routingToggle} htmlFor={`${id}-platform`}>
            <input
              id={`${id}-platform`}
              type="checkbox"
              data-warmup-field="platform"
              checked={false}
              readOnly
              disabled
              aria-describedby={`${id}-platform-note`}
            />
            Alternative Routing (Axiom)
            <em>Unavailable</em>
          </label>
          <label htmlFor={`${id}-schedule`}>
            Wallet order
            <select
              id={`${id}-schedule`}
              {...fieldProps('schedule')}
              value={schedule}
              onChange={(e) => edit(() => setSchedule(e.target.value as WarmupSchedule))}
            >
              <option value="staggered">Overlapping</option>
              <option value="sequential">One wallet at a time</option>
            </select>
          </label>
          <span id={`${id}-platform-note`}>
            Axiom has no public trading route for wallets whose keys stay in your
            browser, so this option is off and adds no fee. Every loop uses the
            reviewed direct swap route.
          </span>
        </fieldset>
        {estimate && (
          <div className={styles.estimate} aria-live="polite">
            <div className={styles.summary}>
              <span>
                <Wallet size={12} /> {addresses.length}/{addresses.length} ready
              </span>
              <span>
                <Clock size={12} />{' '}
                {durationHours
                  ? `${durationHours}h, around the clock`
                  : 'No duration'}
              </span>
              <span>
                Volume {volumeTarget || '0'} {unit.symbol}
              </span>
              <span>Cost ~{estimate.required} {unit.symbol}</span>
            </div>
          </div>
        )}
        <details className={styles.options}>
          <summary>Start time</summary>
          <div className="warmup-fields">
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
        <div className={styles.bottom}>
          <Button
            type="submit"
            variant="secondary"
            size="lg"
            className={styles.startButton}
          >
            {addresses.length
              ? `Start activity on ${addresses.length} wallet${addresses.length === 1 ? '' : 's'}`
              : 'Complete the plan to start'}
          </Button>
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
            const per = Number(doc.amountMax ?? doc.amount);
            setVolumeTarget(
              Number.isFinite(per)
                ? String(per * Math.max(1, doc.cycles) * Math.max(1, addresses.length))
                : '',
            );
            setLossOn(!!doc.feeReserve);
            setMaxLoss(doc.feeReserve ?? '');
            setSchedule(doc.schedule ?? 'staggered');
            setOrganicMode(!!doc.organicTerms);
            if (doc.organicTerms) {
              setOrganicJitter(String(doc.organicTerms.jitterPercent));
              setOrganicHoldMin(String(doc.organicTerms.holdMinSeconds));
              setOrganicHoldMax(String(doc.organicTerms.holdMaxSeconds));
              setOrganicSkip(String(doc.organicTerms.skipPercent));
              setOrganicRandomTokens(doc.organicTerms.randomTokens);
            }
            setTokens(doc.tokens.join('\n'));
            const delay = Math.max(1, warmupDelaySeconds(doc));
            const perDay = String(Math.max(1, Math.round(86400 / delay)));
            setTxMin(perDay);
            setTxMax(perDay);
            setDurationHours(
              String(Math.max(1, Math.round((doc.cycles * delay) / 3600))),
            );
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
      {chain === 'Solana' && <WarmupExecutionInventory />}
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
