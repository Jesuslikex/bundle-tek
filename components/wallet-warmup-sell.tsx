'use client';
import { WarmupApprovedSigning } from './warmup-approved-signing';
import { warmupReviewDeadline } from '@/lib/warmup-review-wait';
import { SwapRouteAssessment } from './swap-route-assessment';
import { SwapInstructionReview } from './swap-instruction-review';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { WarmupBuyReceipts } from './warmup-buy-receipts';
import type { SavedWarmupBuyReceipt } from '@/lib/warmup-buy-receipt';
import {
  requireStoredWarmupBuyLink,
  type WarmupBuyLink,
} from '@/lib/warmup-buy-link';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { SimulatedSwapTokenBalances } from './simulated-swap-token-balances';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
import type { WarmupSellInventory } from '@/lib/warmup-sell-inventory';
import type { SolanaSwapPreparation } from '@/lib/warmup-swap-quote';
import type { ImportedSwapSimulation } from '@/lib/imported-swap-simulation';
import type { SavedWarmupPreparation } from '@/lib/warmup-preparation-history';
import { solanaTokenAtoms } from '@/lib/solana-token-amount';
import { readPanelJson } from './read-panel-json';
import { WarmupTransactionProgress } from './warmup-transaction-progress';
export function WalletWarmupSell({
  plan,
  cycle,
  wallet,
}: {
  plan: SavedWarmup;
  cycle: number;
  wallet: string;
}) {
  const fieldId = useId();
  const [amount, setAmount] = useState('1');
  const [receipt, setReceipt] = useState<SavedWarmupBuyReceipt | null>(null);
  const selectReceipt = useCallback((value: SavedWarmupBuyReceipt | null) => {
    setReceipt(value);
    if (value)
      setAmount(
        formatNativeBalance(
          value.remainingRaw ?? value.document.acquiredRaw,
          value.document.decimals,
        ),
      );
  }, []);
  return (
    <section aria-label="Warmup sell review">
      <h5>Review a warmup sell</h5>
      <p>
        Check current token units for the selected cycle and wallet. A balance
        does not establish which buy acquired those tokens.
      </p>
      <WarmupBuyReceipts
        plan={plan}
        cycle={cycle}
        wallet={wallet}
        selected={receipt}
        onSelect={selectReceipt}
      />
      <label htmlFor={fieldId}>Warmup sell token amount</label>
      <Input
        id={fieldId}
        value={amount}
        maxLength={260}
        inputMode="decimal"
        onChange={(e) => setAmount(e.target.value)}
      />
      <SellRequest
        key={amount + ':' + (receipt?.id ?? 'unlinked')}
        plan={plan}
        cycle={cycle}
        wallet={wallet}
        amount={amount}
        receipt={receipt}
      />
    </section>
  );
}
function SellRequest({
  plan,
  cycle,
  wallet,
  amount,
  receipt,
}: {
  plan: SavedWarmup;
  cycle: number;
  wallet: string;
  amount: string;
  receipt: SavedWarmupBuyReceipt | null;
}) {
  const [inventory, setInventory] = useState<WarmupSellInventory | null>(null);
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
    const expiry = result?.order.expiresAt ?? inventory?.expiresAt;
    if (!expiry) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(expiry) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [result, inventory]);
  const mint = plan.document.tokens[(cycle - 1) % plan.document.tokens.length];
  async function inspect(prepare: boolean) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    setResult(null);
    setInventory(null);
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
          side: 'Sell',
          ...(receipt
            ? {
                buyReceiptId: receipt.id,
                useHistoricalBuy:
                  receipt.planRevision !== plan.revision ||
                  receipt.walletRevision !==
                    plan.document.walletRevisions.find(
                      (w) => w.address === wallet,
                    )?.revision,
              }
            : {}),
          ...(prepare ? { amount } : { mode: 'inventory' }),
        }),
      });
      const data = (await readPanelJson(
        response,
        'Warmup sell review unavailable. Try checking inventory again.',
      )) as {
        id: string;
        revision: number;
        cycle: number;
        walletRevision: number;
        inventory?: WarmupSellInventory;
        order?: SolanaSwapPreparation;
        simulation?: ImportedSwapSimulation;
        reviewWaitMs?: number;
        history?: SavedWarmupPreparation;
        error?: string;
        buyLink?: WarmupBuyLink;
      };
      if (!data || typeof data !== 'object')
        throw new Error(
          'Warmup sell review unavailable. Try checking inventory again.',
        );
      if (!response.ok)
        throw new Error(data.error || 'Warmup sell review unavailable.');
      const value = data.inventory;
      if (
        receipt &&
        (data.buyLink?.receiptId !== receipt.id ||
          data.buyLink.signature !== receipt.document.signature ||
          data.buyLink.acquiredRaw !== receipt.document.acquiredRaw)
      )
        throw new Error(
          'Sell review is not linked to the selected buy receipt.',
        );
      if (receipt)
        requireStoredWarmupBuyLink(
          receipt,
          {
            planId: plan.id,
            planRevision: plan.revision,
            cycle,
            wallet,
            walletRevision:
              plan.document.walletRevisions.find((w) => w.address === wallet)
                ?.revision ?? 0,
            mint,
          },
          data.buyLink,
        );
      if (
        data.id !== plan.id ||
        data.revision !== plan.revision ||
        data.cycle !== cycle ||
        data.walletRevision !==
          plan.document.walletRevisions.find((w) => w.address === wallet)
            ?.revision ||
        !value ||
        value.wallet !== wallet ||
        value.mint !== mint ||
        value.executionAllowed !== false ||
        !Number.isFinite(Date.parse(value.expiresAt)) ||
        Date.parse(value.expiresAt) <= Date.now()
      )
        throw new Error('Inventory does not match this saved plan and wallet.');
      if (prepare) {
        const order = data.order,
          simulation = data.simulation;
        if (
          !order ||
          !simulation ||
          value.decimals === null ||
          !value.amountCovered ||
          !value.preparationSupported ||
          order.side !== 'Sell' ||
          order.inputMint !== mint ||
          order.outputMint !== 'So11111111111111111111111111111111111111112' ||
          order.inAmount !==
            solanaTokenAtoms(amount, value.decimals).toString() ||
          value.requestedRaw !== order.inAmount ||
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
            'Sell preparation does not match this wallet and amount.',
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
          history.document.instructionsVerified !== false ||
          (receipt && history.document.buyReceipt?.receiptId !== receipt.id)
        )
          throw new Error('Saved preparation does not match this review.');
        if (receipt)
          requireStoredWarmupBuyLink(
            receipt,
            {
              planId: plan.id,
              planRevision: plan.revision,
              cycle,
              wallet,
              walletRevision:
                plan.document.walletRevisions.find((w) => w.address === wallet)
                  ?.revision ?? 0,
              mint,
            },
            history.document.buyReceipt,
          );
        if (!controller.signal.aborted)
          setResult({
            order,
            simulation,
            savedId: history.id,
            reviewNotBefore: warmupReviewDeadline(data.reviewWaitMs),
          });
      }
      if (!controller.signal.aborted) setInventory(value);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error ? e.message : 'Warmup sell review unavailable.',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <div>
      {!result && <WarmupTransactionProgress stage="prepare" />}
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => void inspect(false)}
      >
        {busy ? 'Checking warmup sell…' : 'Check warmup sell inventory'}
      </Button>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => void inspect(true)}
      >
        Prepare unsigned warmup sell
      </Button>
      {!receipt && (
        <p>
          No buy lot selected. Use “Use matched buy amount” to cap this sell by
          the acquired units and update that cycle’s lot accounting. Unlinked
          inventory checks and sells do not complete a recorded buy lot.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {inventory && (
        <section aria-label="Warmup sell inventory">
          <p>
            {expired
              ? 'Expired. Refresh before review.'
              : inventory.preparationSupported
                ? 'Supported token inventory observed for unsigned preparation.'
                : 'No supported sell inventory observed.'}
          </p>
          <p className="warmup-address">Token: {mint}</p>
          <p className="warmup-address">
            Token program: {inventory.tokenProgram ?? 'unavailable'}
          </p>
          <p>
            Mint extensions:{' '}
            {inventory.mintExtensions?.join(', ') ||
              (inventory.mintExtensions ? 'none' : 'unavailable')}
            . Mint observation slot: {inventory.mintSlot ?? 'unavailable'}.
          </p>
          {inventory.blockedExtensions?.length > 0 && (
            <p>
              Preparation blocked: {inventory.blockedExtensions.join(', ')}.
            </p>
          )}
          <p>
            Total: {inventory.totalRaw} atomic units. Frozen:{' '}
            {inventory.frozenRaw}. Unfrozen: {inventory.unfrozenRaw}
            {inventory.unfrozenAmount !== null
              ? ` (${inventory.unfrozenAmount} tokens)`
              : ''}
            . Decimals: {inventory.decimals ?? 'unknown'}.
          </p>
          <small>
            {inventory.source} · slots {inventory.minSlot}/{inventory.maxSlot} ·
            observed {new Date(inventory.observedAt).toLocaleString()}.{' '}
            {inventory.limitations}
          </small>
        </section>
      )}
      {result && (
        <section aria-label="Warmup sell preparation result">
          {receipt &&
            (receipt.planRevision !== plan.revision ||
              receipt.walletRevision !==
                plan.document.walletRevisions.find((w) => w.address === wallet)
                  ?.revision) && (
              <p>
                Historical buy lot: plan revision {receipt.planRevision}, wallet
                revision {receipt.walletRevision}. This sell uses current plan
                revision {plan.revision} and fresh holdings. The original buy
                signature and acquisition remain attached.
              </p>
            )}
          <p>
            Saved preparation {result.savedId}. Reopen this plan&apos;s
            preparation history after closing this review.
          </p>
          <p>
            {expired
              ? 'Expired. Prepare a fresh sell order.'
              : result.simulation.succeeded
                ? 'Sell simulation completed. Instruction review remains required.'
                : 'Sell simulation failed. This order cannot proceed.'}
          </p>
          <p>
            Input: {result.order.inAmount} token atomic units. Minimum SOL
            output: {result.order.minimumOutAmount} lamports. RPC fee:{' '}
            {result.simulation.networkFeeLamports} lamports.
          </p>
          <p className="warmup-address">
            Transaction fingerprint: {result.order.preparation.sha256}
          </p>
          {result.simulation.succeeded && (
            <WarmupApprovedSigning
              key={result.savedId}
              planId={plan.id}
              preparationId={result.savedId}
              reviewNotBefore={result.reviewNotBefore}
              order={result.order}
            />
          )}
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
          <small>{result.simulation.limitations}</small>
        </section>
      )}
    </div>
  );
}
