'use client';
import { WarmupApprovedSigning } from './warmup-approved-signing';
import { warmupReviewDeadline } from '@/lib/warmup-review-wait';
import { SwapRouteAssessment } from './swap-route-assessment';
import { useEffect, useId, useRef, useState } from 'react';
import { SimulatedSwapTokenBalances } from './simulated-swap-token-balances';
import { Button } from '@/components/ui/button';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
import type { SolanaSwapPreparation } from '@/lib/warmup-swap-quote';
import type { ImportedSwapSimulation } from '@/lib/imported-swap-simulation';
import type { SavedWarmupPreparation } from '@/lib/warmup-preparation-history';
import { warmupAtoms } from '@/lib/wallet-warmup';
import { WalletWarmupSell } from '@/components/wallet-warmup-sell';
import { SwapInstructionReview } from './swap-instruction-review';
export function WalletWarmupPreparation({
  plan,
  initialCycle = 1,
  initialWallet = plan.document.addresses[0],
  initialSide = 'Buy',
}: {
  plan: SavedWarmup;
  initialCycle?: number;
  initialWallet?: string;
  initialSide?: 'Buy' | 'Sell';
}) {
  const fieldId = useId();
  const [cycle, setCycle] = useState(initialCycle),
    [wallet, setWallet] = useState(initialWallet),
    [side, setSide] = useState(initialSide);
  return (
    <section aria-label="Warmup unsigned preparation">
      <h5>Review a warmup transaction</h5>
      <p>
        Prepare a buy, approve its exact transaction, then verify the finalized
        receipt to use that lot for a sell. Supported routes include SOL
        wrapping, token-account setup and sell unwrapping. Review fees and rent
        before signing.
      </p>
      <label htmlFor={fieldId + '-cycle'}>Preparation cycle</label>
      <select
        id={fieldId + '-cycle'}
        value={cycle}
        onChange={(e) => setCycle(Number(e.target.value))}
      >
        {Array.from({ length: plan.document.cycles }, (_, i) => (
          <option value={i + 1} key={i}>
            Cycle {i + 1}
          </option>
        ))}
      </select>
      <label htmlFor={fieldId + '-wallet'}>Preparation wallet</label>
      <select
        id={fieldId + '-wallet'}
        value={wallet}
        onChange={(e) => setWallet(e.target.value)}
      >
        {plan.document.addresses.map((address) => (
          <option key={address} value={address}>
            {address}
          </option>
        ))}
      </select>
      <label htmlFor={fieldId + '-side'}>Preparation side</label>
      <select
        id={fieldId + '-side'}
        value={side}
        onChange={(event) =>
          setSide(event.target.value === 'Sell' ? 'Sell' : 'Buy')
        }
      >
        <option value="Buy">Buy</option>
        <option value="Sell">Sell</option>
      </select>
      {side === 'Buy' ? (
        <WarmupPreparationRequest
          key={cycle + ':' + wallet}
          plan={plan}
          cycle={cycle}
          wallet={wallet}
        />
      ) : (
        <WalletWarmupSell
          key={'sell:' + cycle + ':' + wallet}
          plan={plan}
          cycle={cycle}
          wallet={wallet}
        />
      )}
    </section>
  );
}
function WarmupPreparationRequest({
  plan,
  cycle,
  wallet,
}: {
  plan: SavedWarmup;
  cycle: number;
  wallet: string;
}) {
  const [result, setResult] = useState<{
    order: SolanaSwapPreparation;
    simulation: ImportedSwapSimulation;
    savedId: string;
    reviewNotBefore: number;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [expired, setExpired] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(result.order.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [result]);
  const mint = plan.document.tokens[(cycle - 1) % plan.document.tokens.length];
  async function prepare() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    setResult(null);
    setExpired(false);
    try {
      const response = await fetch('/api/wallet-workspace/warmup/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          id: plan.id,
          revision: plan.revision,
          cycle,
          wallet,
        }),
      });
      const data = (await response.json()) as {
        id: string;
        revision: number;
        cycle: number;
        walletRevision: number;
        order?: SolanaSwapPreparation;
        simulation?: ImportedSwapSimulation;
        reviewWaitMs?: number;
        history?: SavedWarmupPreparation;
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.error || 'Warmup preparation unavailable.');
      const order = data.order,
        simulation = data.simulation;
      if (
        data.id !== plan.id ||
        data.revision !== plan.revision ||
        data.cycle !== cycle ||
        data.walletRevision !==
          plan.document.walletRevisions.find((w) => w.address === wallet)
            ?.revision ||
        !order ||
        !simulation ||
        order.side !== 'Buy' ||
        order.inputMint !== 'So11111111111111111111111111111111111111112' ||
        order.outputMint !== mint ||
        order.inAmount !== warmupAtoms(plan.document.amount, 9).toString() ||
        order.executionAllowed !== false ||
        order.preparation.wallet !== wallet ||
        order.preparation.executionAllowed !== false ||
        order.preparation.instructionsVerified !== false ||
        simulation.wallet !== wallet ||
        simulation.sha256 !== order.preparation.sha256 ||
        simulation.executionAllowed !== false ||
        simulation.instructionsVerified !== false ||
        !Number.isFinite(Date.parse(order.expiresAt)) ||
        Date.parse(order.expiresAt) <= Date.now()
      )
        throw new Error(
          'Preparation does not match this saved plan and wallet.',
        );
      const history = data.history;
      if (
        !history ||
        history.planId !== plan.id ||
        history.planRevision !== plan.revision ||
        history.cycle !== cycle ||
        history.walletRevision !== data.walletRevision ||
        history.document.wallet !== wallet ||
        history.document.transaction.sha256 !== order.preparation.sha256 ||
        history.document.executionAllowed !== false ||
        history.document.instructionsVerified !== false
      )
        throw new Error('Saved preparation does not match this review.');
      if (!controller.signal.aborted)
        setResult({
          order,
          simulation,
          savedId: history.id,
          reviewNotBefore: warmupReviewDeadline(data.reviewWaitMs),
        });
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error ? e.message : 'Warmup preparation unavailable.',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <div>
      <p className="warmup-address">
        Cycle {cycle}: Spend {plan.document.amount} SOL to buy {mint}.
      </p>
      <Button variant="outline" disabled={busy} onClick={() => void prepare()}>
        {busy ? 'Preparing warmup buy…' : 'Prepare unsigned warmup buy'}
      </Button>
      {error && <p role="alert">{error}</p>}
      {result && (
        <section aria-label="Warmup preparation result">
          <p>
            Saved preparation {result.savedId}. Reopen this plan&apos;s
            preparation history after closing this review.
          </p>
          <p>
            {expired
              ? 'Expired. Prepare a fresh order.'
              : result.simulation.succeeded
                ? 'RPC simulation completed. Instruction review is still required.'
                : 'RPC simulation failed. This order cannot proceed.'}
          </p>
          <p>
            Minimum output: {result.order.minimumOutAmount} atomic units. RPC
            fee: {result.simulation.networkFeeLamports} lamports. Wallet SOL
            change: {result.simulation.nativeChangeRaw ?? 'unavailable'}{' '}
            lamports.
          </p>
          <p>
            Compute units: {result.simulation.unitsConsumed ?? 'unavailable'} ·{' '}
            {result.simulation.source} · simulation slot{' '}
            {result.simulation.simulationSlot}.
          </p>
          <p className="warmup-address">
            Transaction fingerprint: {result.order.preparation.sha256}
          </p>
          <WarmupApprovedSigning
            key={result.savedId}
            planId={plan.id}
            preparationId={result.savedId}
            reviewNotBefore={result.reviewNotBefore}
            order={result.order}
          />
          <SimulatedSwapTokenBalances simulation={result.simulation} />
          <SwapRouteAssessment
            assessment={result.simulation.routeAssessment}
            bindings={result.simulation.accountBindings}
          />
          <SwapInstructionReview
            review={
              result.simulation.instructionReview ??
              result.order.preparation.instructionReview
            }
            lookupObservation={result.simulation.lookupObservation}
          />
          <small>
            Expires {new Date(result.order.expiresAt).toLocaleString()}.{' '}
            {result.simulation.limitations}
          </small>
        </section>
      )}
    </div>
  );
}
