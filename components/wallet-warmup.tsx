'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  buildWarmupPlan,
  nativeUnits,
  type WarmupHistory,
  type WarmupPlan,
} from '@/lib/wallet-warmup';
import type { LaunchChain } from '@/lib/launch-plan';
import { WalletWarmupPlans } from '@/components/wallet-warmup-plans';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
import { WarmupPlanSummary } from './warmup-plan-summary';
import { readPanelJson } from './read-panel-json';

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
  const [interval, setInterval] = useState(
    String(initialPlan?.document.intervalMinutes ?? 120),
  );
  const [start, setStart] = useState(() => {
    if (!initialPlan) return '';
    const date = new Date(initialPlan.document.startAt);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  });
  const [plan, setPlan] = useState<WarmupPlan | null>(null);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<HistoryResult[]>([]);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const edit = (change: () => void) => {
    change();
    setPlan(null);
    setError('');
  };
  async function inspect() {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError('');
    setHistory([]);
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
      if (!controller.signal.aborted) setBusy(false);
    }
  }
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
    <section className="wallet-warmup-panel" aria-labelledby={`${id}-title`}>
      <div className="wallet-roster-actions">
        <h3 id={`${id}-title`}>Wallet warmup</h3>
        <Button variant="ghost" onClick={onClose}>
          Close warmup
        </Button>
      </div>
      <p>
        {addresses.length} selected {chain} wallets. Review small buy/sell
        cycles and inspect existing activity.
      </p>
      <p>
        Start by checking wallet history, then choose your tokens and review a
        plan. You can save a plan for an unfunded wallet. Saving does not fund
        the wallet or start trades.
      </p>
      <p className="text-muted-foreground">
        Each swap requires a fresh quote and your approval before execution.
        There is no background scheduler. Activity cannot guarantee launch
        eligibility or establish wallet creation age.
      </p>
      <Button variant="outline" disabled={busy} onClick={inspect}>
        {busy ? 'Checking activity…' : 'Check wallet history'}
      </Button>
      {history.length > 0 && (
        <div className="warmup-history" aria-live="polite">
          {history.map((r) => (
            <article key={r.address}>
              <strong className="warmup-address">{r.address}</strong>
              {r.error ? (
                <output>{r.error}</output>
              ) : (
                r.observation && (
                  <>
                    <p>
                      {r.observation.nativeBalance} {r.observation.currency} ·{' '}
                      {r.observation.outgoingTransactions === null
                        ? `${r.observation.sampleCount} sampled signatures, ${r.observation.successfulSampleCount} successful`
                        : `${r.observation.outgoingTransactions} account nonce`}
                    </p>
                    {r.observation.nativeBalance === '0' && (
                      <p>
                        No {r.observation.currency} balance was observed. You
                        can inspect history and save a draft, but a swap needs
                        enough balance for its amount, fees and any account
                        rent. Check preflight after saving; no funding or trade
                        happens automatically.
                      </p>
                    )}
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
                      {new Date(r.observation.observedAt).toLocaleString()} at
                      block/slot {r.observation.block}. Source:{' '}
                      {r.observation.source}.
                    </small>
                  </>
                )
              )}
            </article>
          ))}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            setPlan(
              buildWarmupPlan({
                chain,
                addresses,
                tokens: tokens.split(/[\s,]+/).filter(Boolean),
                amount,
                feeReserve: reserve,
                cycles: Number(cycles),
                intervalMinutes: Number(interval),
                startAt: start ? new Date(start).toISOString() : '',
              }),
            );
            setError('');
          } catch (e) {
            setPlan(null);
            setError(e instanceof Error ? e.message : 'Invalid warmup plan.');
          }
        }}
      >
        <div className="warmup-fields">
          <label htmlFor={`${id}-amount`}>
            Buy amount per cycle ({unit.symbol})
            <Input
              id={`${id}-amount`}
              value={amount}
              onChange={(e) => edit(() => setAmount(e.target.value))}
              inputMode="decimal"
              required
            />
          </label>
          <label htmlFor={`${id}-reserve`}>
            Fee reserve per wallet ({unit.symbol})
            <Input
              id={`${id}-reserve`}
              value={reserve}
              onChange={(e) => edit(() => setReserve(e.target.value))}
              inputMode="decimal"
              required
            />
          </label>
          <label htmlFor={`${id}-cycles`}>
            Cycles per wallet
            <Input
              id={`${id}-cycles`}
              type="number"
              min={1}
              max={20}
              value={cycles}
              onChange={(e) => edit(() => setCycles(e.target.value))}
              required
            />
          </label>
          <label htmlFor={`${id}-interval`}>
            Minutes between cycles
            <Input
              id={`${id}-interval`}
              type="number"
              min={15}
              max={10080}
              value={interval}
              onChange={(e) => edit(() => setInterval(e.target.value))}
              required
            />
          </label>
          <label htmlFor={`${id}-start`}>
            Start time
            <Input
              id={`${id}-start`}
              type="datetime-local"
              value={start}
              onChange={(e) => edit(() => setStart(e.target.value))}
              required
            />
          </label>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            edit(() => {
              const date = new Date(Date.now() + 5 * 60000);
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
        <label>
          Token addresses, one per line
          <textarea
            className="warmup-token-input"
            value={tokens}
            onChange={(e) => edit(() => setTokens(e.target.value))}
            rows={3}
            maxLength={500}
            required
          />
        </label>
        <small>
          Enter up to 10 mint/contract addresses. Tokens rotate by cycle. Token
          identity and liquidity have not been checked. Each sell uses only
          tokens acquired by its matching buy.
        </small>
        <div>
          <Button type="submit">Review warmup plan</Button>
        </div>
      </form>
      {error && <p role="alert">{error}</p>}
      {plan && <WarmupPlanSummary plan={plan} />}
      <WalletWarmupPlans
        initialPlan={initialPlan}
        chain={chain}
        addresses={addresses}
        walletRevisions={walletRevisions}
        plan={plan}
        onLoad={(doc) => {
          setAmount(doc.amount);
          setReserve(doc.feeReserve);
          setTokens(doc.tokens.join('\n'));
          setCycles(String(doc.cycles));
          setInterval(String(doc.intervalMinutes));
          const date = new Date(doc.startAt);
          setStart(
            new Date(date.getTime() - date.getTimezoneOffset() * 60000)
              .toISOString()
              .slice(0, 16),
          );
          setPlan(null);
          setError('');
        }}
      />
      {plan && (
        <section aria-label="Warmup plan review">
          <h4>{plan.actions.length} planned actions</h4>
          <p>
            Buys start at fixed staggered offsets within the first quarter of
            each interval. Sells follow half an interval later. Sell proceeds do
            not reduce the budget.
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
        </section>
      )}
    </section>
  );
}
