'use client';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  dcaTradeSessionInput,
  dcaPerCycleBudget,
} from '@/lib/dca-trade-session';
import {
  decodeTradeSession,
  validatedTradeSessionControls,
  sessionEntryNotBefore,
  type TradeSession,
  type TradeSessionControl,
} from '@/lib/imported-trade-session';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { DcaMarketPool } from './dca-market-pool';
import {
  randomDcaAllocation,
  type DcaRandomization,
} from '@/lib/dca-random-allocation';
import { solanaTokenAtoms } from '@/lib/solana-token-amount';
import {
  dcaSupplyBasis,
  dcaSupplyInput,
  type DcaSupplySizing,
} from '@/lib/dca-supply-sizing';
import { formatNativeBalance } from '@/lib/wallet-balance-format';

export function DcaTradeSession({
  project,
  wallets,
  locked,
  onSaved,
  onBusyChange,
}: {
  project: ImportedTokenProject;
  wallets: WorkspaceWallet[];
  locked: boolean;
  onSaved: (session: TradeSession, control: TradeSessionControl) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [side, setSide] = useState<'Buy' | 'Sell'>('Buy'),
    [wallet, setWallet] = useState(''),
    [amount, setAmount] = useState(''),
    [amountMode, setAmountMode] = useState<'total' | 'per-cycle'>('total'),
    [sellUnit, setSellUnit] = useState<'tokens' | 'supply'>('tokens'),
    [cycles, setCycles] = useState('5'),
    [interval, setInterval] = useState('60'),
    [start, setStart] = useState(''),
    [end, setEnd] = useState(''),
    [ending, setEnding] = useState<'deadline' | 'duration'>('deadline'),
    [duration, setDuration] = useState(''),
    [sizing, setSizing] = useState<'even' | 'randomized'>('even'),
    [cycleMinimum, setCycleMinimum] = useState(''),
    [cycleMaximum, setCycleMaximum] = useState(''),
    [allocation, setAllocation] = useState<{
      key: string;
      amountsRaw: string[];
    } | null>(null),
    [rangeEnabled, setRangeEnabled] = useState(false),
    [pair, setPair] = useState(''),
    [minimum, setMinimum] = useState('0'),
    [maximum, setMaximum] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState<{ key: string; text: string } | null>(null);
  const pending = useRef<AbortController | null>(null);
  const amountId = useId(),
    cyclesId = useId(),
    intervalId = useId(),
    startId = useId();
  const endId = useId();
  const durationId = useId();
  const minimumId = useId(),
    maximumId = useId();
  const cycleMinimumId = useId(),
    cycleMaximumId = useId();
  const retry = useRef<{ key: string; id: string } | null>(null);
  useEffect(
    () => () => {
      if (pending.current) {
        pending.current.abort();
        onBusyChange?.(false);
      }
    },
    [onBusyChange],
  );
  const roster = wallets.filter((w) => w.chain === 'Solana' && !w.archived);
  const useSupply = side === 'Sell' && sellUnit === 'supply';
  const basis = useMemo(() => {
    try {
      return dcaSupplyBasis(project.document.token);
    } catch {
      return null;
    }
  }, [project.document.token]);
  const unit =
    side === 'Buy'
      ? 'SOL'
      : useSupply
        ? '% of saved supply'
        : project.document.token.symbol;
  const amountResult = useMemo<{
    terms: {
      totalRaw: string;
      randomization?: DcaRandomization;
      supplySizing?: DcaSupplySizing;
    } | null;
    error: string;
  }>(() => {
    try {
      const inputAmount =
        amountMode === 'per-cycle'
          ? dcaPerCycleBudget(
              amount,
              useSupply
                ? 6
                : side === 'Buy'
                  ? 9
                  : project.document.token.decimals,
              Number(cycles),
            )
          : amount;
      if (useSupply) {
        const sized = dcaSupplyInput(project.document.token, {
          totalPercent: inputAmount,
          ...(sizing === 'randomized'
            ? { minimumPercent: cycleMinimum, maximumPercent: cycleMaximum }
            : {}),
        });
        return {
          terms: {
            totalRaw: sized.totalRaw,
            supplySizing: sized.sizing,
            ...(sizing === 'randomized'
              ? {
                  randomization: {
                    format: 'bounded-dca-allocation-v1' as const,
                    totalRaw: sized.totalRaw,
                    minimumRaw: sized.minimumRaw!,
                    maximumRaw: sized.maximumRaw!,
                  },
                }
              : {}),
          },
          error: '',
        };
      }
      const decimals = side === 'Buy' ? 9 : project.document.token.decimals,
        totalRaw = solanaTokenAtoms(inputAmount, decimals).toString();
      return {
        terms: {
          totalRaw,
          ...(sizing === 'randomized'
            ? {
                randomization: {
                  format: 'bounded-dca-allocation-v1' as const,
                  totalRaw,
                  minimumRaw: solanaTokenAtoms(
                    cycleMinimum,
                    decimals,
                  ).toString(),
                  maximumRaw: solanaTokenAtoms(
                    cycleMaximum,
                    decimals,
                  ).toString(),
                },
              }
            : {}),
        },
        error: '',
      };
    } catch (error) {
      return {
        terms: null,
        error:
          error instanceof Error
            ? error.message
            : 'Enter a supported DCA amount.',
      };
    }
  }, [
    useSupply,
    side,
    sizing,
    amount,
    amountMode,
    cycles,
    cycleMinimum,
    cycleMaximum,
    project.document.token,
  ]);
  const amountTerms = amountResult.terms;
  const selectedWallet = wallets.find(
    (w) => w.address === wallet && w.chain === 'Solana' && !w.archived,
  );
  const allocationKey = JSON.stringify({
    project: project.id,
    revision: project.revision,
    mint: project.document.token.address,
    decimals: project.document.token.decimals,
    side,
    wallet,
    walletRevision: selectedWallet?.revision,
    amount,
    amountMode,
    cycles,
    cycleMinimum,
    cycleMaximum,
    useSupply,
    ...(useSupply
      ? {
          supplyRaw: basis?.totalSupplyRaw,
          supplyObservedAt: basis?.observedAt,
        }
      : {}),
  });
  const draftKey = JSON.stringify({
    allocationKey,
    allocation,
    sizing,
    sellUnit,
    start,
    interval,
    end,
    ending,
    duration,
    rangeEnabled,
    pair,
    minimum,
    maximum,
    archived: project.archived,
  });
  const message = notice?.key === draftKey ? notice.text : '';
  function setMessage(text: string) {
    setNotice(text ? { key: draftKey, text } : null);
  }
  function generate() {
    if (locked || busy || project.archived || !selectedWallet) return;
    try {
      if (!amountTerms?.randomization)
        throw new Error(
          'Enter supported total, minimum and maximum inputs before generating.',
        );
      const amountsRaw = randomDcaAllocation(
        amountTerms.totalRaw,
        Number(cycles),
        amountTerms.randomization,
      );
      setAllocation({ key: allocationKey, amountsRaw });
      setMessage(
        'Random allocation generated. Review every cycle before saving.',
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Random allocation unavailable.',
      );
    }
  }
  const preview = useMemo(() => {
    try {
      const selected = wallets.find(
        (w) => w.address === wallet && w.chain === 'Solana' && !w.archived,
      );
      if (
        !selected ||
        !amountTerms ||
        !start ||
        !/^[1-9]\d?$/.test(cycles) ||
        !/^[1-9]\d{0,4}$/.test(interval)
      )
        return null;
      if (sizing === 'randomized' && allocation?.key !== allocationKey)
        return null;
      return dcaTradeSessionInput(
        {
          projectId: project.id,
          projectRevision: project.revision,
          side,
          wallet,
          walletRevision: selected.revision,
          totalAmount: formatNativeBalance(
            amountTerms.totalRaw,
            side === 'Buy' ? 9 : project.document.token.decimals,
          ),
          ...(amountTerms.supplySizing
            ? { supplySizing: amountTerms.supplySizing }
            : {}),
          cycles: Number(cycles),
          startAt: new Date(start).toISOString(),
          intervalSeconds: Number(interval),
          ...(sizing === 'randomized'
            ? {
                randomization: amountTerms.randomization!,
                cycleAmountsRaw: allocation!.amountsRaw,
              }
            : {}),
          ...(ending === 'duration'
            ? {
                durationSeconds: /^\d+$/.test(duration)
                  ? Number(duration)
                  : NaN,
              }
            : end
              ? { endsAt: new Date(end).toISOString() }
              : {}),
          ...(rangeEnabled
            ? {
                marketCapRange: {
                  pair,
                  minimumUsd: minimum,
                  ...(maximum ? { maximumUsd: maximum } : {}),
                },
              }
            : {}),
        },
        project.document.token,
      );
    } catch {
      return null;
    }
  }, [
    wallets,
    wallet,
    start,
    end,
    ending,
    duration,
    cycles,
    interval,
    project,
    side,
    rangeEnabled,
    pair,
    minimum,
    maximum,
    sizing,
    allocation,
    allocationKey,
    amountTerms,
  ]);
  const disabled = locked || busy || project.archived;
  async function save() {
    if (!preview || disabled || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    onBusyChange?.(true);
    setMessage('');
    const key = JSON.stringify(preview.request);
    if (retry.current?.key !== key)
      retry.current = { key, id: crypto.randomUUID() };
    const id = retry.current.id;
    try {
      const response = await fetch('/api/imported-projects/trade-sessions', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...preview.request, id }),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15000),
        ]),
      });
      const body = (await response.json().catch(() => null)) as {
        session?: unknown;
        control?: unknown;
        executionAllowed?: boolean;
        error?: string;
      } | null;
      if (controller.signal.aborted) return;
      if (!response.ok)
        throw new Error(
          body?.error || 'DCA session unavailable. Retry the same draft.',
        );
      const session = decodeTradeSession(body?.session);
      if (
        session.id !== id ||
        body?.executionAllowed !== false ||
        JSON.stringify(session.terms) !== JSON.stringify(preview.terms)
      )
        throw new Error(
          'Saved DCA differs. Reload session history before reviewing.',
        );
      const [control] = validatedTradeSessionControls(
        [body?.control],
        [session],
      );
      onSaved(session, control);
      setMessage(
        'DCA session saved. Review each due cycle below before signing.',
      );
    } catch (error) {
      if (!controller.signal.aborted)
        setMessage(
          error instanceof Error ? error.message : 'DCA session unavailable.',
        );
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        onBusyChange?.(false);
      }
      if (pending.current === controller) pending.current = null;
    }
  }
  return (
    <details className="@container rounded-md border p-3">
      <summary>Create DCA session</summary>
      <div className="mt-3 space-y-4">
        <p className="text-sm text-muted-foreground">
          Split an exact input budget into 2 to 25 scheduled cycles for one
          wallet. Each cycle needs a fresh review, signature and separate
          submission. Due time is eligibility, not a promised execution time.
        </p>
        <fieldset className="grid gap-3 @min-[520px]:grid-cols-2">
          <legend className="mb-2 font-medium">Trade setup</legend>
          <label>
            DCA side
            <select
              value={side}
              disabled={disabled}
              onChange={(e) => {
                setSide(e.target.value as 'Buy' | 'Sell');
                setAmount('');
                setCycleMinimum('');
                setCycleMaximum('');
              }}
            >
              <option value="Buy">Buy with SOL</option>
              <option value="Sell">Sell project tokens</option>
            </select>
          </label>
          <label>
            DCA wallet
            <select
              value={wallet}
              disabled={disabled}
              onChange={(e) => setWallet(e.target.value)}
            >
              <option value="">Choose wallet</option>
              {roster.map((w) => (
                <option key={w.address} value={w.address}>
                  {w.label || w.address}
                </option>
              ))}
            </select>
          </label>
          {side === 'Sell' && (
            <label>
              Sell amount unit
              <select
                value={sellUnit}
                disabled={disabled}
                onChange={(e) => {
                  setSellUnit(e.target.value as 'tokens' | 'supply');
                  setAmount('');
                  setCycleMinimum('');
                  setCycleMaximum('');
                }}
              >
                <option value="tokens">Token amounts</option>
                <option value="supply" disabled={!basis}>
                  % of saved supply
                </option>
              </select>
            </label>
          )}
          {useSupply && basis && (
            <p className="col-span-full text-sm text-muted-foreground">
              Supply basis:{' '}
              {formatNativeBalance(
                basis.totalSupplyRaw,
                project.document.token.decimals,
              )}{' '}
              {project.document.token.symbol}, observed {basis.observedAt}. This
              is saved total mint supply. The total rounds down to token atoms;
              random minimums round up and maximums round down. Refreshing the
              project requires a new session.
            </p>
          )}
          <label>
            DCA input mode
            <select
              value={amountMode}
              disabled={disabled || sizing === 'randomized'}
              onChange={(e) => {
                setAmountMode(e.target.value as 'total' | 'per-cycle');
                setAmount('');
                setAllocation(null);
              }}
            >
              <option value="total">Total budget across all cycles</option>
              <option value="per-cycle">Per-cycle target</option>
            </select>
          </label>
          <label htmlFor={amountId}>
            {amountMode === 'per-cycle'
              ? 'Input per DCA cycle'
              : 'Total DCA input'}{' '}
            ({unit})
            <Input
              id={amountId}
              inputMode="decimal"
              value={amount}
              disabled={disabled}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          {amount && amountResult.error && (
            <p role="alert" className="col-span-full">
              {amountResult.error}
            </p>
          )}
          {amountTerms && (
            <p
              className="col-span-full text-sm"
              aria-label="DCA total input budget"
            >
              Total input budget:{' '}
              {formatNativeBalance(
                amountTerms.totalRaw,
                side === 'Buy' ? 9 : project.document.token.decimals,
              )}{' '}
              {side === 'Buy' ? 'SOL' : project.document.token.symbol} across{' '}
              {cycles} cycles. Fees and rent are additional.
              {amountMode === 'per-cycle' && useSupply && (
                <>
                  {' '}
                  Target: {amount}% of saved supply per cycle,{' '}
                  {amountTerms.supplySizing?.totalPercent}% total. The total
                  rounds down to token atoms, then splits evenly; cycle inputs
                  can differ by one atom. Review every exact amount below.
                </>
              )}
            </p>
          )}
          <label htmlFor={cyclesId}>
            DCA cycles
            <Input
              id={cyclesId}
              inputMode="numeric"
              value={cycles}
              disabled={disabled}
              onChange={(e) => setCycles(e.target.value)}
            />
          </label>
          <label>
            DCA amount sizing
            <select
              value={sizing}
              disabled={disabled}
              onChange={(e) => {
                const next = e.target.value as 'even' | 'randomized';
                setSizing(next);
                if (next === 'randomized' && amountMode === 'per-cycle') {
                  setAmountMode('total');
                  setAmount('');
                  setAllocation(null);
                }
              }}
            >
              <option value="even">Even split</option>
              <option value="randomized">Randomized within bounds</option>
            </select>
          </label>
          {sizing === 'randomized' && (
            <fieldset
              disabled={disabled}
              className="col-span-full grid gap-3 @min-[520px]:grid-cols-2"
            >
              <legend>Randomized cycle amounts ({unit})</legend>
              <label htmlFor={cycleMinimumId}>
                Minimum input per cycle
                <Input
                  id={cycleMinimumId}
                  inputMode="decimal"
                  value={cycleMinimum}
                  onChange={(e) => setCycleMinimum(e.target.value)}
                />
              </label>
              <label htmlFor={cycleMaximumId}>
                Maximum input per cycle
                <Input
                  id={cycleMaximumId}
                  inputMode="decimal"
                  value={cycleMaximum}
                  onChange={(e) => setCycleMaximum(e.target.value)}
                />
              </label>
              <Button
                type="button"
                className="col-span-full justify-self-start"
                onClick={generate}
                disabled={disabled || !selectedWallet}
              >
                Generate random allocation
              </Button>
              <p className="col-span-full text-sm text-muted-foreground">
                Randomized sizing uses a total budget. Generate once to preview
                all amounts. Every cycle stays within these bounds and the total
                input stays exact. Saving, retries and signing reuse this
                allocation. Change the amount, cycle count, wallet or bounds to
                generate a new preview.
              </p>
            </fieldset>
          )}
        </fieldset>
        <fieldset className="grid gap-3 @min-[520px]:grid-cols-2">
          <legend className="mb-2 font-medium">Timing</legend>
          <label htmlFor={intervalId}>
            Seconds between DCA cycles
            <Input
              id={intervalId}
              inputMode="numeric"
              value={interval}
              disabled={disabled}
              onChange={(e) => setInterval(e.target.value)}
            />
          </label>
          <label htmlFor={startId}>
            DCA start in your local timezone
            <Input
              id={startId}
              type="datetime-local"
              value={start}
              disabled={disabled}
              onChange={(e) => setStart(e.target.value)}
              onInput={(e) => setStart(e.currentTarget.value)}
            />
          </label>
          <p className="col-span-full text-sm text-muted-foreground">
            Intervals support 1 to 86400 seconds. Buy budgets exclude network
            fees; every cycle rereads available funds. Even-split remainder
            atoms go to the earliest cycles. Pause or cancel remaining cycles in
            saved session controls.
          </p>
        </fieldset>
        <details className="rounded-md border p-3">
          <summary>End conditions</summary>
          <div className="mt-3 grid gap-3 @min-[520px]:grid-cols-2">
            <label>
              DCA stop rule
              <select
                value={ending}
                disabled={disabled}
                onChange={(e) => {
                  setEnding(e.target.value as 'deadline' | 'duration');
                  setEnd('');
                  setDuration('');
                }}
              >
                <option value="deadline">Calendar deadline (optional)</option>
                <option value="duration">Duration from scheduled start</option>
              </select>
            </label>
            {ending === 'duration' ? (
              <label htmlFor={durationId}>
                DCA duration in seconds
                <Input
                  id={durationId}
                  inputMode="numeric"
                  value={duration}
                  disabled={disabled}
                  onChange={(e) => setDuration(e.target.value)}
                />
              </label>
            ) : (
              <label htmlFor={endId}>
                DCA end in your local timezone (optional)
                <Input
                  id={endId}
                  type="datetime-local"
                  value={end}
                  disabled={disabled}
                  onChange={(e) => setEnd(e.target.value)}
                  onInput={(e) => setEnd(e.currentTarget.value)}
                />
              </label>
            )}
            <p className="col-span-full text-sm text-muted-foreground">
              Duration is measured from the saved scheduled start, including
              time spent paused or waiting for an eligible market. It does not
              restart when the first cycle executes.
            </p>
            <p className="col-span-full text-sm text-muted-foreground">
              An end time must follow the final scheduled cycle. At that time
              new preparation, approval and submission stop; retained signatures
              and receipts remain recoverable.
            </p>
          </div>
        </details>
        {preview?.terms.endsAt && (
          <p className="text-sm">DCA stops at {preview.terms.endsAt} (UTC).</p>
        )}
        <details className="rounded-md border p-3">
          <summary>
            Market-cap filter{rangeEnabled ? ' · Enabled' : ' (optional)'}
          </summary>
          <div className="mt-3 space-y-3">
            <label>
              <input
                type="checkbox"
                checked={rangeEnabled}
                disabled={disabled}
                onChange={(e) => setRangeEnabled(e.target.checked)}
              />
              Limit DCA to a market-cap range
            </label>
            {rangeEnabled && (
              <fieldset
                disabled={disabled}
                className="grid gap-3 @min-[520px]:grid-cols-2"
              >
                <legend>Market-cap range</legend>
                <div className="col-span-full">
                  <DcaMarketPool
                    project={project}
                    value={pair}
                    disabled={disabled}
                    onChange={setPair}
                  />
                </div>
                <label htmlFor={minimumId}>
                  Minimum market cap (USD)
                  <Input
                    id={minimumId}
                    inputMode="decimal"
                    value={minimum}
                    onChange={(e) => setMinimum(e.target.value)}
                  />
                </label>
                <label htmlFor={maximumId}>
                  Maximum market cap (USD, optional)
                  <Input
                    id={maximumId}
                    inputMode="decimal"
                    value={maximum}
                    onChange={(e) => setMaximum(e.target.value)}
                  />
                </label>
                <p className="col-span-full text-sm text-muted-foreground">
                  Choose a saved market pool. Zero minimum and a blank maximum
                  are unbounded. Bounds are inclusive. Every cycle needs a fresh
                  observation for this pool before preparation, approval and
                  submission.
                </p>
              </fieldset>
            )}
          </div>
        </details>
        {preview?.terms.marketCapRange && (
          <p>
            Saved range: ${preview.terms.marketCapRange.minimumUsd} to{' '}
            {preview.terms.marketCapRange.maximumUsd === undefined
              ? 'no maximum'
              : '$' + preview.terms.marketCapRange.maximumUsd}
            . A cycle outside this range waits for a fresh eligible observation;
            signatures and receipts remain recoverable.
          </p>
        )}
        {preview ? (
          <ol
            className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm"
            aria-label="DCA cycle preview"
          >
            {preview.terms.entries.map((e) => (
              <li key={e.entry}>
                Cycle {e.entry}: {e.amount}{' '}
                {side === 'Buy' ? 'SOL' : project.document.token.symbol}.
                Eligible {sessionEntryNotBefore(preview.terms, e.entry)} (UTC).
              </li>
            ))}
          </ol>
        ) : (
          <p>
            Choose a current wallet, exact positive budget, 2 to 25 cycles and a
            valid start to review the schedule.
          </p>
        )}
        <Button disabled={disabled || !preview} onClick={() => void save()}>
          Save DCA session
        </Button>
        {sizing === 'randomized' &&
          allocation &&
          allocation.key !== allocationKey && (
            <output className="block">
              Input changed. Generate a new allocation before saving.
            </output>
          )}
        {message && <output className="block">{message}</output>}
      </div>
    </details>
  );
}
