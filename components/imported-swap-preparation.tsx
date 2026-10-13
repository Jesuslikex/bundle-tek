'use client';
import {
  validatedTradeSessionCapture,
  type TradeSessionRequest,
  type TradeSessionCapture,
} from '@/lib/imported-trade-session';
import { SwapRouteAssessment } from './swap-route-assessment';
import { WarmupApprovedSigning } from './warmup-approved-signing';
import { warmupReviewDeadline } from '@/lib/warmup-review-wait';
import { SwapInstructionReview } from './swap-instruction-review';
import { useEffect, useRef, useState } from 'react';
import { SimulatedSwapTokenBalances } from './simulated-swap-token-balances';
import { Button } from '@/components/ui/button';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import type { SolanaSwapPreparation } from '@/lib/warmup-swap-quote';
import { warmupAtoms } from '@/lib/wallet-warmup';
import { solanaTokenAtoms } from '@/lib/solana-token-amount';
import type { ImportedSwapBalance } from '@/lib/imported-swap-balance';
import type { ImportedSwapSimulation } from '@/lib/imported-swap-simulation';
import type { ImportedSwapReceipt } from '@/lib/imported-approval-history';
import {
  validatedImportedAcquisitionSelection,
  importedAcquisitionAllocations,
  type ImportedAcquisitionAllocation,
  type ImportedAcquisitionSelection,
} from '@/lib/imported-acquisition';
import { ImportedAcquisitionReview } from './imported-acquisition-review';
import type {
  ConditionalLevelRequest,
  ConditionalPreparation,
} from '@/lib/conditional-preparation-server';
import type { ConditionalOrder } from '@/lib/conditional-order';
import { requireSelectedConditionalPreparation } from '@/lib/conditional-preparation-selection';
export function ImportedSwapPreparation({
  project,
  wallet,
  side,
  amount,
  locked,
  onReviewBuy,
  buyReceiptId,
  buyAllocations,
  conditional,
  conditionalOrder,
  session,
  sessionNotBefore,
  preparationJobId,
}: {
  project: ImportedTokenProject;
  wallet: WorkspaceWallet;
  side: 'Buy' | 'Sell';
  amount: string;
  locked: boolean;
  onReviewBuy?: (receipt: ImportedSwapReceipt) => void;
  buyReceiptId?: string;
  buyAllocations?: ImportedAcquisitionAllocation[];
  conditional?: ConditionalLevelRequest;
  conditionalOrder?: ConditionalOrder;
  session?: TradeSessionRequest;
  sessionNotBefore?: string;
  preparationJobId?: string;
}) {
  const [balance, setBalance] = useState<ImportedSwapBalance | null>(null);
  const [sessionCapture, setSessionCapture] = useState<
    TradeSessionCapture | undefined
  >();
  const [order, setOrder] = useState<SolanaSwapPreparation | null>(null);
  const [simulation, setSimulation] = useState<ImportedSwapSimulation | null>(
    null,
  );
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [expired, setExpired] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [acquisition, setAcquisition] = useState<
    ImportedAcquisitionSelection | undefined
  >();
  const [reviewNotBefore, setReviewNotBefore] = useState(0);
  const [conditionCapture, setConditionCapture] =
    useState<ConditionalPreparation>();
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (!order) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(
        0,
        Math.min(
          Date.parse(order.expiresAt),
          balance ? Date.parse(balance.expiresAt) : Infinity,
          conditionCapture ? Date.parse(conditionCapture.expiresAt) : Infinity,
        ) - Date.now(),
      ),
    );
    return () => clearTimeout(timer);
  }, [order, balance, conditionCapture]);
  async function prepare() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setOrder(null);
    setBalance(null);
    setSimulation(null);
    setError('');
    setBusy(true);
    setExpired(false);
    setSavedId(null);
    setSessionCapture(undefined);
    setAcquisition(undefined);
    setConditionCapture(undefined);
    try {
      const raw = (
        side === 'Buy'
          ? warmupAtoms(amount, 9)
          : solanaTokenAtoms(amount, project.document.token.decimals)
      ).toString();
      if (buyAllocations && (buyReceiptId || side !== 'Sell'))
        throw new Error('Choose one accounting selection for a sale.');
      const requestedAllocations = buyAllocations
        ? importedAcquisitionAllocations(buyAllocations, raw)
        : undefined;
      const response = await fetch(
        preparationJobId
          ? `/api/imported-projects/session-preparation-jobs?${new URLSearchParams({ projectId: project.id, sessionId: session?.sessionId ?? '', jobId: preparationJobId })}`
          : '/api/imported-projects/prepare',
        {
          method: preparationJobId ? 'GET' : 'POST',
          headers: preparationJobId
            ? undefined
            : { 'content-type': 'application/json' },
          signal: controller.signal,
          body: preparationJobId
            ? undefined
            : JSON.stringify({
                id: project.id,
                revision: project.revision,
                wallet: wallet.address,
                walletRevision: wallet.revision,
                side,
                amount,
                ...(buyReceiptId ? { buyReceiptId } : {}),
                ...(requestedAllocations
                  ? { buyAllocations: requestedAllocations }
                  : {}),
                ...(conditional ? { conditional } : {}),
                ...(session ? { session } : {}),
              }),
        },
      );
      const data = (await response.json()) as {
        id: string;
        revision: number;
        walletRevision: number;
        order?: SolanaSwapPreparation;
        simulation?: ImportedSwapSimulation;
        balance?: ImportedSwapBalance;
        reviewWaitMs?: number;
        history?: {
          id: string;
          projectId: string;
          projectRevision: number;
          walletRevision: number;
          document: {
            executionAllowed: boolean;
            transaction: { sha256: string };
            acquisition?: ImportedAcquisitionSelection;
            conditional?: ConditionalPreparation;
            session?: TradeSessionCapture;
          };
        };
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.error || 'Swap preparation unavailable.');
      const value = data.order;
      if (
        data.id !== project.id ||
        data.revision !== project.revision ||
        data.walletRevision !== wallet.revision ||
        !value ||
        value.side !== side ||
        value.inAmount !== raw ||
        value.inputMint !==
          (side === 'Buy'
            ? 'So11111111111111111111111111111111111111112'
            : project.document.token.address) ||
        value.outputMint !==
          (side === 'Buy'
            ? project.document.token.address
            : 'So11111111111111111111111111111111111111112') ||
        value.executionAllowed !== false ||
        value.preparation.wallet !== wallet.address ||
        value.preparation.executionAllowed !== false ||
        value.preparation.instructionsVerified !== false ||
        !Number.isFinite(Date.parse(value.expiresAt)) ||
        Date.parse(value.expiresAt) <= Date.now()
      )
        throw new Error('Preparation does not match this wallet and trade.');
      if (
        !data.balance ||
        data.balance.wallet !== wallet.address ||
        data.balance.mint !== project.document.token.address ||
        data.balance.side !== side ||
        data.balance.requestedRaw !== raw ||
        data.balance.executionAllowed !== false ||
        !data.balance.amountCovered ||
        !data.balance.preparationSupported ||
        !Number.isFinite(Date.parse(data.balance.expiresAt)) ||
        Date.parse(data.balance.expiresAt) <= Date.now()
      )
        throw new Error('Fresh balance does not match this wallet and trade.');
      if (
        !data.simulation ||
        data.simulation.sha256 !== value.preparation.sha256 ||
        data.simulation.wallet !== wallet.address ||
        data.simulation.executionAllowed !== false ||
        data.simulation.instructionsVerified !== false
      )
        throw new Error('Simulation does not match this unsigned transaction.');
      if (
        !data.history ||
        data.history.projectId !== project.id ||
        data.history.projectRevision !== project.revision ||
        data.history.walletRevision !== wallet.revision ||
        data.history.document.executionAllowed !== false ||
        data.history.document.transaction.sha256 !== value.preparation.sha256
      )
        throw new Error('Preparation history does not match this review.');
      const deadline = warmupReviewDeadline(data.reviewWaitMs);
      const capturedSession = data.history.document.session;
      if (session) {
        const capture = validatedTradeSessionCapture(
          capturedSession,
          value.inAmount,
        );
        if (
          capture.sessionId !== session.sessionId ||
          capture.sessionRevision !== session.revision ||
          capture.entry !== session.entry ||
          capture.notBefore !== sessionNotBefore
        )
          throw new Error('Trade session response differs.');
      } else if (capturedSession !== undefined)
        throw new Error('Unexpected session binding.');
      if (!controller.signal.aborted) setSessionCapture(capturedSession);
      const capturedCondition = data.history.document.conditional;
      if (conditional) {
        await requireSelectedConditionalPreparation(
          capturedCondition,
          conditional,
          conditionalOrder,
          {
            projectId: project.id,
            projectRevision: project.revision,
            wallet: wallet.address,
            walletRevision: wallet.revision,
            mint: project.document.token.address,
            decimals: project.document.token.decimals,
            side,
            unitsRaw: raw,
          },
        );
      } else if (capturedCondition !== undefined)
        throw new Error('Unexpected conditional order binding.');
      if (!controller.signal.aborted) setConditionCapture(capturedCondition);
      let selectedAcquisition: ImportedAcquisitionSelection | undefined;
      if (buyReceiptId || requestedAllocations) {
        selectedAcquisition = validatedImportedAcquisitionSelection(
          data.history?.document.acquisition,
          {
            projectId: project.id,
            wallet: wallet.address,
            mint: project.document.token.address,
            unitsRaw: raw,
          },
        );
        if (
          side !== 'Sell' ||
          selectedAcquisition.decimals !== project.document.token.decimals
        )
          throw new Error('Selected acquisition changed.');
        if (requestedAllocations) {
          if (
            !('kind' in selectedAcquisition) ||
            JSON.stringify(
              selectedAcquisition.allocations.map(
                ({ buyReceiptId, unitsRaw }) => ({ buyReceiptId, unitsRaw }),
              ),
            ) !== JSON.stringify(requestedAllocations)
          )
            throw new Error('Selected acquisition allocations changed.');
        } else if (
          'kind' in selectedAcquisition ||
          selectedAcquisition.buyReceiptId !== buyReceiptId
        )
          throw new Error('Selected acquisition changed.');
      } else if (data.history?.document.acquisition !== undefined)
        throw new Error('Unexpected acquisition assignment.');
      if (!controller.signal.aborted) setAcquisition(selectedAcquisition);
      if (!controller.signal.aborted) setReviewNotBefore(deadline);
      if (!controller.signal.aborted) setSavedId(data.history.id);
      if (!controller.signal.aborted) setBalance(data.balance);
      if (!controller.signal.aborted) setOrder(value);
      if (!controller.signal.aborted) setSimulation(data.simulation);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error ? e.message : 'Swap preparation unavailable.',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label="Unsigned imported swap">
      <h4>Prepare swap</h4>
      {conditional && (
        <p>
          Conditional order {conditional.orderId}, level {conditional.level}.
          This prepares an unsigned transaction only.
        </p>
      )}
      {buyAllocations && (
        <p>
          {buyAllocations.length} recorded acquisitions selected. Preparation
          captures each exact allocation and fee-inclusive cost for your
          approval.
        </p>
      )}
      {buyReceiptId && (
        <p>
          Selected buy receipt: <code>{buyReceiptId}</code>. Preparing this sell
          captures its remaining accounting capacity and allocated buy cost for
          your approval.
        </p>
      )}
      <p>
        Check fresh input balances, then request an unsigned transaction and
        independent RPC simulation for this public wallet address. This does not
        unlock a signer or submit a trade.
      </p>
      <Button
        variant="outline"
        disabled={busy || locked}
        onClick={() => void prepare()}
      >
        {busy
          ? 'Preparing swap…'
          : preparationJobId
            ? 'Review queued unsigned swap'
            : 'Prepare unsigned swap'}
      </Button>
      {error && <p role="alert">{error}</p>}
      {savedId && (
        <p>
          Saved preparation {savedId}. Open this project’s preparation history
          to review it after closing this panel.
        </p>
      )}
      {order && (
        <section aria-label="Unsigned swap preparation result">
          <p>
            {expired
              ? 'Expired. Prepare a fresh order.'
              : `Unsigned ${side.toLowerCase()} via ${order.router} · 0.5% slippage`}
          </p>
          {balance && (
            <section aria-label="Swap input balance">
              <p>
                Fresh input balance covers {balance.requestedRaw} atomic units.
                Frozen token units excluded: {balance.frozenRaw}.
              </p>
              <p>
                Observed {balance.observedAt} at confirmed slot{' '}
                {balance.nativeSlot}. Fee coverage remains unverified.
              </p>
            </section>
          )}
          <p>
            Input: {order.inAmount} atomic units. Minimum output:{' '}
            {order.minimumOutAmount} atomic units.
          </p>
          <p>
            Provider fee estimate: {order.preparation.estimatedFeesLamports}{' '}
            lamports, including rent. These estimates have not been verified
            against RPC.
          </p>
          <p>
            {order.preparation.transactionBytes} bytes ·{' '}
            {order.preparation.instructionCount} instructions ·{' '}
            {order.preparation.lookupTableCount} lookup tables · last valid
            block height {order.preparation.lastValidBlockHeight}
          </p>
          <p className="warmup-address">
            Transaction fingerprint: {order.preparation.sha256}
          </p>
          <p>{order.preparation.limitations}</p>
          <SwapInstructionReview
            review={
              simulation?.instructionReview ??
              order.preparation.instructionReview
            }
            lookupObservation={simulation?.lookupObservation}
          />
          {simulation && (
            <section aria-label="Unsigned swap simulation">
              <p>
                {simulation.succeeded
                  ? 'RPC simulation completed. Instruction review is still required.'
                  : 'RPC simulation failed. This order cannot proceed.'}
              </p>
              <p>
                RPC network fee: {simulation.networkFeeLamports} lamports.
                Compute units: {simulation.unitsConsumed ?? 'unavailable'}.
                Simulated wallet SOL change:{' '}
                {simulation.nativeChangeRaw ?? 'unavailable'} lamports.
              </p>
              <p>
                {simulation.source} · confirmed fee slot {simulation.feeSlot} ·
                simulation slot {simulation.simulationSlot} · block height{' '}
                {simulation.blockHeight}
              </p>
              <SimulatedSwapTokenBalances simulation={simulation} />
              <SwapRouteAssessment
                assessment={simulation.routeAssessment}
                bindings={simulation.accountBindings}
              />
              <p>{simulation.limitations}</p>
            </section>
          )}
          {savedId && (
            <>
              {acquisition && (
                <ImportedAcquisitionReview acquisition={acquisition} />
              )}
              <WarmupApprovedSigning
                key={savedId}
                preparationId={savedId}
                expectedAcquisition={acquisition}
                expectedConditional={conditionCapture ?? undefined}
                expectedSession={sessionCapture}
                projectId={project.id}
                order={order}
                reviewNotBefore={reviewNotBefore}
                onReviewImportedBuy={onReviewBuy}
              />
            </>
          )}
        </section>
      )}
    </section>
  );
}
