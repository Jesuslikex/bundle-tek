'use client';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { dcaTradeSessionInput } from '@/lib/dca-trade-session';
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
    [cycles, setCycles] = useState('5'),
    [interval, setInterval] = useState('60'),
    [start, setStart] = useState(''),
    [end, setEnd] = useState(''),
    [rangeEnabled, setRangeEnabled] = useState(false),
    [pair, setPair] = useState(''),
    [minimum, setMinimum] = useState('0'),
    [maximum, setMaximum] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  const amountId = useId(),
    cyclesId = useId(),
    intervalId = useId(),
    startId = useId();
  const endId = useId();
  const minimumId = useId(),
    maximumId = useId();
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
  const preview = useMemo(() => {
    try {
      const selected = wallets.find(
        (w) => w.address === wallet && w.chain === 'Solana' && !w.archived,
      );
      if (
        !selected ||
        !start ||
        !/^[1-9]\d?$/.test(cycles) ||
        !/^[1-9]\d{0,4}$/.test(interval)
      )
        return null;
      return dcaTradeSessionInput(
        {
          projectId: project.id,
          projectRevision: project.revision,
          side,
          wallet,
          walletRevision: selected.revision,
          totalAmount: amount,
          cycles: Number(cycles),
          startAt: new Date(start).toISOString(),
          intervalSeconds: Number(interval),
          ...(end ? { endsAt: new Date(end).toISOString() } : {}),
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
    cycles,
    interval,
    project,
    side,
    amount,
    rangeEnabled,
    pair,
    minimum,
    maximum,
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
    <details className="rounded-md border p-3">
      <summary>Create DCA session</summary>
      <p>
        Split an exact input budget into 2 to 25 scheduled cycles for one
        wallet. Each cycle needs a fresh review, signature and separate
        submission. Due time is eligibility, not a promised execution time.
      </p>
      <label>
        DCA side
        <select
          value={side}
          disabled={disabled}
          onChange={(e) => {
            setSide(e.target.value as 'Buy' | 'Sell');
            setAmount('');
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
      <label htmlFor={amountId}>
        Total DCA input (
        {side === 'Buy' ? 'SOL' : project.document.token.symbol})
        <Input
          id={amountId}
          inputMode="decimal"
          value={amount}
          disabled={disabled}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
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
      <p>
        Intervals support 1 to 86400 seconds. Buy budgets exclude network fees;
        every cycle rereads available funds. Remainder atoms go to the earliest
        cycles. Pause or cancel remaining cycles in saved session controls.
      </p>
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
      <p>
        An end time must follow the final scheduled cycle. At that time new
        preparation, approval and submission stop; retained signatures and
        receipts remain recoverable.
      </p>
      {preview?.terms.endsAt && (
        <p>DCA stops at {preview.terms.endsAt} (UTC).</p>
      )}
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
        <fieldset disabled={disabled} className="space-y-2">
          <legend>Market-cap range</legend>
          <DcaMarketPool
            project={project}
            value={pair}
            disabled={disabled}
            onChange={setPair}
          />
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
          <p>
            Choose a saved market pool. Zero minimum and a blank maximum are
            unbounded. Bounds are inclusive. Every cycle needs a fresh
            observation for this pool before preparation, approval and
            submission.
          </p>
        </fieldset>
      )}
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
        <ol aria-label="DCA cycle preview">
          {preview.terms.entries.map((e) => (
            <li key={e.entry}>
              Cycle {e.entry}: {e.amount}{' '}
              {side === 'Buy' ? 'SOL' : project.document.token.symbol}. Eligible{' '}
              {sessionEntryNotBefore(preview.terms, e.entry)} (UTC).
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
      {message && <output className="block">{message}</output>}
    </details>
  );
}
