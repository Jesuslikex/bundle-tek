'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { CounterPlan } from '@/lib/counter-trade-store';
import type { CounterBuyTargetQuote } from '@/lib/counter-buy-quote';
import { warmupAtoms } from '@/lib/wallet-warmup';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { readPanelJson } from './read-panel-json';
import { Button } from './ui/button';
import { Input } from './ui/input';
const SOL = 'So11111111111111111111111111111111111111112';
const MAX = (1n << 64n) - 1n;
function raw(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(value) ||
    BigInt(value) > MAX
  )
    throw Error('Counter price amounts are invalid.');
  return BigInt(value);
}
function validatePreview(
  value: unknown,
  plan: CounterPlan,
  identity: string,
  budget: string,
) {
  const data = value as {
    executionAllowed?: unknown;
    quote?: CounterBuyTargetQuote;
  };
  const q = data?.quote,
    target = plan.ledger.decisions.find((d) => d.identity === identity);
  if (
    data?.executionAllowed !== false ||
    !q ||
    q.executionAllowed !== false ||
    q.format !== 'counter-buy-target-quote-v1' ||
    q.projectId !== plan.projectId ||
    q.projectRevision !== plan.ledger.scope.revision ||
    q.planId !== plan.id ||
    q.planRevision !== plan.revision ||
    q.decisionIdentity !== identity ||
    q.inputMint !== SOL ||
    q.outputMint !== plan.ledger.scope.mint ||
    q.outputTargetRaw !== target?.proposalTokenRaw ||
    q.reviewedSolBudgetRaw !== budget ||
    q.swapMode !== 'ExactOut' ||
    q.slippageBps !== 50 ||
    q.source !== 'api.jup.ag'
  )
    throw Error('Counter price preview differs from the selected proposal.');
  const required = raw(q.requiredSolInputRaw),
    ceiling = raw(q.maximumSolInputRaw);
  raw(q.outputTargetRaw);
  if (
    ceiling < required ||
    ceiling > raw(budget) ||
    ceiling > (required * 10050n + 9999n) / 10000n
  )
    throw Error('Counter price preview exceeds the reviewed swap-input limit.');
  const observed = Date.parse(q.observedAt),
    expires = Date.parse(q.expiresAt),
    now = Date.now();
  if (
    !Number.isFinite(observed) ||
    !Number.isFinite(expires) ||
    observed > now + 1000 ||
    expires <= now ||
    expires <= observed ||
    expires - observed > 30000 ||
    !Number.isSafeInteger(q.contextSlot) ||
    q.contextSlot < 0
  )
    throw Error('Counter price preview has expired or its context is invalid.');
  return { quote: q, receivedAt: now };
}
export function CounterBuyPrice({
  plan,
  locked,
}: {
  plan: CounterPlan;
  locked: boolean;
}) {
  if (plan.rules.responseSide !== 'Buy') return null;
  return (
    <PriceControls
      key={JSON.stringify([
        plan.projectId,
        plan.id,
        plan.revision,
        plan.state,
        plan.ledger,
        locked,
      ])}
      plan={plan}
      locked={locked}
    />
  );
}
function PriceControls({
  plan,
  locked,
}: {
  plan: CounterPlan;
  locked: boolean;
}) {
  const field = useId(),
    pending = useRef<AbortController | null>(null);
  const [identity, setIdentity] = useState(''),
    [budget, setBudget] = useState(''),
    [quote, setQuote] = useState<CounterBuyTargetQuote | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [now, setNow] = useState(() => Date.now());
  const proposals = plan.ledger.decisions.filter(
    (d) => d.outcome === 'proposal' && d.proposalTokenRaw !== null,
  );
  const expired = quote !== null && Date.parse(quote.expiresAt) <= now;
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (!quote || expired) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [quote, expired]);
  async function price() {
    if (pending.current || locked || plan.state !== 'active') return;
    setError('');
    setQuote(null);
    let budgetRaw: string;
    try {
      const decision = proposals.find((d) => d.identity === identity);
      if (!decision) throw Error('Choose a saved Buy proposal.');
      const amount = warmupAtoms(budget, 9);
      if (amount < 1n || amount > MAX)
        throw Error('Choose a positive SOL swap-input limit.');
      budgetRaw = amount.toString();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Invalid Counter pricing request.',
      );
      return;
    }
    const c = new AbortController();
    pending.current = c;
    setBusy(true);
    try {
      const response = await fetch('/api/imported-projects/counter-quotes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: plan.projectId,
          projectRevision: plan.ledger.scope.revision,
          planId: plan.id,
          planRevision: plan.revision,
          decisionIdentity: identity,
          maximumSolAmount: budget,
        }),
        signal: AbortSignal.any([c.signal, AbortSignal.timeout(30000)]),
      });
      const data = await readPanelJson(
        response,
        'Counter pricing unavailable. Reload saved history before retrying.',
      );
      if (!response.ok)
        throw Error(
          (data as { error?: string })?.error || 'Counter pricing unavailable.',
        );
      if (!c.signal.aborted && pending.current === c) {
        const preview = validatePreview(data, plan, identity, budgetRaw);
        setQuote(preview.quote);
        setNow(preview.receivedAt);
      }
    } catch (e) {
      if (!c.signal.aborted)
        setError(
          e instanceof Error ? e.message : 'Counter pricing unavailable.',
        );
    } finally {
      if (!c.signal.aborted && pending.current === c) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <section aria-label="Counter Buy pricing">
      <h4>Price a Buy target</h4>
      <p>
        Select a retained proposal and set its maximum SOL swap input. Pricing
        does not confirm that the source signal is still eligible.
      </p>
      <label htmlFor={`${field}-proposal`}>Buy proposal</label>
      <select
        id={`${field}-proposal`}
        value={identity}
        disabled={busy || locked || plan.state !== 'active'}
        onChange={(e) => {
          setIdentity(e.target.value);
          setQuote(null);
          setError('');
        }}
      >
        <option value="">Choose a recorded proposal</option>
        {proposals.map((d, i) => (
          <option key={d.identity} value={d.identity}>
            Proposal {i + 1}:{' '}
            {formatNativeBalance(
              d.proposalTokenRaw!,
              plan.ledger.scope.decimals,
            )}{' '}
            tokens
          </option>
        ))}
      </select>
      <label htmlFor={`${field}-budget`}>Maximum swap input (SOL)</label>
      <Input
        id={`${field}-budget`}
        inputMode="decimal"
        value={budget}
        maxLength={30}
        disabled={busy || locked || plan.state !== 'active'}
        onChange={(e) => {
          setBudget(e.target.value);
          setQuote(null);
          setError('');
        }}
        placeholder="Enter your SOL limit"
      />
      <Button
        type="button"
        disabled={
          busy || locked || plan.state !== 'active' || !identity || !budget
        }
        onClick={() => void price()}
      >
        Price selected Buy proposal
      </Button>
      {!proposals.length && <p>No recorded Buy proposals yet.</p>}
      <div aria-live="polite">
        {busy && <p>Pricing the selected target…</p>}
        {error && <p role="alert">{error}</p>}
        {quote &&
          (expired ? (
            <p>Price preview expired. Request a fresh preview.</p>
          ) : (
            <>
              <p>
                Target:{' '}
                {formatNativeBalance(
                  quote.outputTargetRaw,
                  plan.ledger.scope.decimals,
                )}{' '}
                tokens.
              </p>
              <p>
                Estimated swap input:{' '}
                {formatNativeBalance(quote.requiredSolInputRaw, 9)} SOL. Quote
                input ceiling:{' '}
                {formatNativeBalance(quote.maximumSolInputRaw, 9)} SOL. Your
                limit: {formatNativeBalance(quote.reviewedSolBudgetRaw, 9)} SOL.
              </p>
              <p>
                Expires: {new Date(quote.expiresAt).toLocaleTimeString()}. Swap
                amounts exclude network fees and account rent.
              </p>
              <p>
                Preview only. Transaction preparation and signing are not
                connected.
              </p>
            </>
          ))}
      </div>
    </section>
  );
}
