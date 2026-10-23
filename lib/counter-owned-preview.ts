import { readAutoBuyBudget } from './auto-buy-budget-store';
import { AutoBuyBudgetError } from './auto-buy-budget';
import {
  bindCounterAutoBuyAccountingCandidate,
  counterAutoBuyCandidateIdentity,
  AutoBuyCounterCandidateError,
} from './auto-buy-counter-candidate';
import { env } from './server-env';
import { UUID } from './wallet-operation';
import { walletAddress } from './wallet-workspace';
import { decodeCounterPlan } from './counter-trade-store';
import { prepareCounterBuyProposal } from './counter-buy-preparation';
import { simulateCounterBuyPreparation } from './counter-buy-simulation';
import { reviewCounterBuySettlement } from './counter-buy-settlement';
import { balanceRpc } from './wallet-balances';
import { getSolanaIndexerRpcEndpoint } from './solana-rpc';
import { WRAPPED_SOL } from './warmup-swap-quote';
import {
  reviewCounterBuySources,
  CounterSourceReviewError,
} from './counter-source-review';
import { observePoolTradeMovement } from './pool-trade-movement-server';
import { collectCounterBuyRuntimeEvidence } from './counter-buy-runtime';

export type CounterPreviewRequest = {
  projectId: string;
  projectRevision: number;
  planId: string;
  planRevision: number;
  decisionIdentity: string;
  wallet: string;
  walletRevision: number;
  maximumSolInputRaw: string;
  maximumFeeAndRentRaw: string;
};
export class CounterPreviewError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
const raw = (value: unknown, positive = false) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n ||
    (positive && value === '0')
  )
    throw new CounterPreviewError('Choose exact bounded Counter amounts.', 400);
  return value;
};
export function counterPreviewRequest(value: unknown): CounterPreviewRequest {
  const v = value as CounterPreviewRequest;
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).sort().join(',') !==
      'decisionIdentity,maximumFeeAndRentRaw,maximumSolInputRaw,planId,planRevision,projectId,projectRevision,wallet,walletRevision' ||
    !UUID.test(v.projectId) ||
    !UUID.test(v.planId) ||
    [v.projectRevision, v.planRevision, v.walletRevision].some(
      (n) => !Number.isSafeInteger(n) || n < 1 || n > 1e9,
    ) ||
    typeof v.decisionIdentity !== 'string' ||
    !v.decisionIdentity ||
    v.decisionIdentity.length > 512
  )
    throw new CounterPreviewError(
      'Choose the current Counter proposal and wallet revisions.',
      400,
    );
  try {
    walletAddress(v.wallet, 'Solana');
  } catch {
    throw new CounterPreviewError('Choose a valid Counter wallet.', 400);
  }
  raw(v.maximumSolInputRaw, true);
  raw(v.maximumFeeAndRentRaw);
  return structuredClone(v);
}
type Context = {
  project_document: string;
  mint: string;
  project_revision: number;
  plan_document: string;
  plan_revision: number;
  plan_state: string;
  wallet_revision: number;
  wallet_role: string;
  wallet_updated_at: string;
};
type Dependencies = {
  observeSource: typeof observePoolTradeMovement;
  prepare: (
    plan: Parameters<typeof prepareCounterBuyProposal>[0],
    decision: string,
    budget: string,
    wallet: string,
    signal: AbortSignal,
  ) => ReturnType<typeof prepareCounterBuyProposal>;
  simulate: typeof simulateCounterBuyPreparation;
  settle: typeof reviewCounterBuySettlement;
};
/** Read-only owned diagnostic. No retained packet, reservation, approval or signing authority. */
async function collectOwnedCounterBuyEvidence(
  db: D1Database,
  owner: string,
  value: CounterPreviewRequest,
  signal: AbortSignal,
  supplied?: Dependencies,
  beforeProvider?: (
    plan: ReturnType<typeof decodeCounterPlan>,
  ) => Promise<void>,
  runtimeSimulation?: Dependencies['simulate'],
) {
  const input = counterPreviewRequest(value);
  signal = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  const access =
      "FROM counter_trade_plans c JOIN imported_token_projects p ON p.owner_id=c.owner_id AND p.id=c.project_id JOIN workspace_wallets w ON w.owner_id=c.owner_id AND w.chain='Solana' AND w.address=? WHERE c.owner_id=? AND c.project_id=? AND c.id=? AND c.revision=? AND c.state='active' AND p.chain='Solana' AND p.revision=? AND p.archived=0 AND w.revision=? AND w.archived=0 AND w.role IN ('Recipient','Deployer','Funder') AND EXISTS(SELECT 1 FROM wallet_ownership_proofs o WHERE o.owner_id=c.owner_id AND o.chain='Solana' AND o.address=w.address)",
    missing =
      "SELECT o.address FROM wallet_ownership_proofs o WHERE o.owner_id=c.owner_id AND o.chain='Solana' AND NOT EXISTS(SELECT 1 FROM json_each(c.document,'$.rules.ignoredWallets') x WHERE x.value=o.address)",
    parameters = [
      input.wallet,
      owner,
      input.projectId,
      input.planId,
      input.planRevision,
      input.projectRevision,
      input.walletRevision,
    ];
  const read = () =>
    db
      .prepare(
        `SELECT p.document AS project_document,p.address AS mint,p.revision AS project_revision,c.document AS plan_document,c.revision AS plan_revision,c.state AS plan_state,w.revision AS wallet_revision,w.role AS wallet_role,w.updated_at AS wallet_updated_at ${access} AND NOT EXISTS(${missing})`,
      )
      .bind(...parameters)
      .first<Context>();
  const refuseContext = async (message: string): Promise<never> => {
    signal.throwIfAborted();
    // Explain an exclusion refusal only under the same owned project/wallet guards.
    const row = await db
      .prepare(
        `SELECT (${missing} ORDER BY o.address LIMIT 1) AS missing_wallet ${access}`,
      )
      .bind(...parameters)
      .first<{ missing_wallet: string | null }>();
    signal.throwIfAborted();
    if (row?.missing_wallet)
      throw new CounterPreviewError(
        `Proven wallet ${walletAddress(row.missing_wallet, 'Solana')} is missing from this Counter plan's ignore list. Counter must not react to your own wallets. Review a new plan including this wallet before previewing.`,
      );
    throw new CounterPreviewError(message);
  };
  signal.throwIfAborted();
  const context = await read();
  if (!context)
    return refuseContext(
      'Owned Counter proposal, exclusions or wallet changed. Reload saved history.',
    );
  const plan = decodeCounterPlan(JSON.parse(context.plan_document)),
    token = JSON.parse(context.project_document)?.token;
  const decision = plan.ledger.decisions.find(
    (d) => d.identity === input.decisionIdentity,
  );
  if (
    plan.id !== input.planId ||
    plan.projectId !== input.projectId ||
    plan.revision !== context.plan_revision ||
    plan.state !== context.plan_state ||
    plan.rules.responseSide !== 'Buy' ||
    plan.projectDocument !== context.project_document ||
    plan.ledger.scope.revision !== context.project_revision ||
    plan.ledger.scope.mint !== context.mint ||
    token?.chain !== 'Solana' ||
    token.address !== context.mint ||
    token.decimals !== plan.ledger.scope.decimals ||
    decision?.outcome !== 'proposal' ||
    decision.proposalTokenRaw === null
  )
    throw new CounterPreviewError(
      'Counter proposal, mint identity or precision changed.',
    );
  const unchanged = async () => {
    signal.throwIfAborted();
    if (JSON.stringify(await read()) !== JSON.stringify(context))
      await refuseContext(
        'Counter context changed during the preview. Request a fresh preview.',
      );
    signal.throwIfAborted();
  };
  if (beforeProvider) await beforeProvider(plan);
  if (
    !supplied &&
    (!env.JUPITER_API_KEY?.trim() ||
      /\s/.test(env.JUPITER_API_KEY) ||
      env.JUPITER_API_KEY.length > 1000)
  )
    throw new CounterPreviewError(
      'Counter preview provider is not configured.',
      503,
    );
  const provider =
    supplied ??
    ({
      observeSource: observePoolTradeMovement,
      prepare: (plan, decision, budget, wallet, s) => {
        const endpoint = getSolanaIndexerRpcEndpoint();
        return prepareCounterBuyProposal(
          plan,
          decision,
          budget,
          wallet,
          env.JUPITER_API_KEY,
          s,
          fetch,
          (method, params, scope) =>
            balanceRpc(endpoint, method, params, scope, fetch),
        );
      },
      simulate: simulateCounterBuyPreparation,
      settle: reviewCounterBuySettlement,
    } satisfies Dependencies);
  try {
    signal.throwIfAborted();
    await reviewCounterBuySources(
      plan,
      input.decisionIdentity,
      signal,
      provider.observeSource,
    );
    await unchanged();
    const prepared = await provider.prepare(
      plan,
      input.decisionIdentity,
      input.maximumSolInputRaw,
      input.wallet,
      signal,
    );
    const quote = prepared.quote;
    if (
      quote.projectId !== input.projectId ||
      quote.projectRevision !== input.projectRevision ||
      quote.planId !== input.planId ||
      quote.planRevision !== input.planRevision ||
      quote.decisionIdentity !== input.decisionIdentity ||
      prepared.preparation.wallet !== input.wallet ||
      prepared.tokenDecimals !== token.decimals ||
      quote.outputMint !== context.mint ||
      quote.outputTargetRaw !== decision.proposalTokenRaw ||
      quote.reviewedSolBudgetRaw !== input.maximumSolInputRaw ||
      quote.inputMint !== WRAPPED_SOL ||
      quote.slippageBps !== 50 ||
      BigInt(raw(quote.requiredSolInputRaw, true)) >
        BigInt(raw(quote.maximumSolInputRaw, true)) ||
      BigInt(quote.maximumSolInputRaw) > BigInt(input.maximumSolInputRaw) ||
      quote.swapMode !== 'ExactOut' ||
      !/^[a-f0-9]{64}$/.test(prepared.preparation.sha256) ||
      quote.executionAllowed !== false ||
      prepared.executionAllowed !== false ||
      prepared.instructionsVerified !== false
    )
      throw new CounterPreviewError(
        'Prepared Counter packet differs from the owned proposal.',
      );
    await unchanged();
    const simulation = await (runtimeSimulation ?? provider.simulate)(
      prepared,
      input.maximumFeeAndRentRaw,
      signal,
    );
    await unchanged();
    const settlement = await provider.settle(
      prepared,
      simulation,
      input.maximumFeeAndRentRaw,
    );
    if (
      settlement.sha256 !== prepared.preparation.sha256 ||
      settlement.swapMode !== 'ExactOut' ||
      settlement.wallet !== input.wallet ||
      settlement.projectId !== input.projectId ||
      settlement.projectRevision !== input.projectRevision ||
      settlement.planId !== input.planId ||
      settlement.planRevision !== input.planRevision ||
      settlement.decisionIdentity !== input.decisionIdentity ||
      settlement.reviewedFeeAndRentLimitRaw !== input.maximumFeeAndRentRaw ||
      settlement.executionAllowed !== false ||
      settlement.instructionsVerified !== false ||
      settlement.expiresAt !== prepared.expiresAt ||
      BigInt(raw(settlement.actualInputRaw, true)) >
        BigInt(quote.maximumSolInputRaw) ||
      BigInt(raw(simulation.networkFeeLamports)) >
        BigInt(input.maximumFeeAndRentRaw) ||
      !Number.isFinite(Date.parse(prepared.expiresAt)) ||
      Date.parse(prepared.expiresAt) <= Date.now()
    )
      throw new CounterPreviewError(
        'Counter settlement is stale or differs from the owned preview.',
      );
    await unchanged();
    const sourceReview = await reviewCounterBuySources(
      plan,
      input.decisionIdentity,
      signal,
      provider.observeSource,
    );
    await unchanged();
    if (Date.parse(prepared.expiresAt) <= Date.now())
      throw new CounterPreviewError(
        'Counter packet preview expired during source verification. Request a fresh preview.',
      );
    const preview = {
      format: 'owned-counter-buy-preview-v1' as const,
      ...input,
      mint: context.mint,
      tokenDecimals: token.decimals as number,
      packetSha256: prepared.preparation.sha256,
      outputTargetRaw: quote.outputTargetRaw,
      requiredSolInputRaw: quote.requiredSolInputRaw,
      maximumQuoteInputRaw: quote.maximumSolInputRaw,
      actualSimulatedInputRaw: settlement.actualInputRaw,
      networkFeeLamports: simulation.networkFeeLamports,
      observedAt: simulation.observedAt,
      expiresAt: new Date(
        Math.min(
          Date.parse(prepared.expiresAt),
          Date.parse(sourceReview.sourceValidUntil),
        ),
      ).toISOString(),
      ownershipContextRechecked: true as const,
      grossSettlementReviewed: true as const,
      sourceRevalidated: true as const,
      ...sourceReview,
      programCodeAttested: false as const,
      reservationCreated: false as const,
      approvalAllowed: false as const,
      signingAllowed: false as const,
      executionAllowed: false as const,
      limitations:
        'Read-only preview with contributing source trades rechecked. Durable packet/budget storage, reservations, code admission and separate approval/signing/recovery remain required.',
    };
    return {
      preview,
      input,
      plan,
      prepared,
      simulation,
      settlement,
      sourceReview,
      unchanged,
      recheckSource: () =>
        reviewCounterBuySources(
          plan,
          input.decisionIdentity,
          signal,
          provider.observeSource,
        ),
    };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof CounterSourceReviewError)
      throw new CounterPreviewError(error.message);
    if (error instanceof CounterPreviewError) throw error;
    throw new CounterPreviewError(
      'Counter preparation, simulation or settlement could not be verified. No approval was created.',
      502,
    );
  }
}

/** Original public DTO and owned query ordering are preserved. Raw evidence stays private. */
export async function previewOwnedCounterBuy(
  db: D1Database,
  owner: string,
  value: CounterPreviewRequest,
  signal: AbortSignal,
  supplied?: Dependencies,
) {
  return (
    await collectOwnedCounterBuyEvidence(db, owner, value, signal, supplied)
  ).preview;
}

/** Fresh unsigned identity evidence for the original ExactOut packet. It uses
 * the same owned/source/gross-settlement admission as the ordinary preview;
 * neither observed code identity nor a successful simulation grants authority.
 */
export async function previewOwnedCounterBuyRuntime(
  db: D1Database,
  owner: string,
  value: CounterPreviewRequest,
  signal: AbortSignal,
  supplied?: Dependencies & {
    runtime: typeof collectCounterBuyRuntimeEvidence;
  },
) {
  let runtime:
    | Awaited<ReturnType<typeof collectCounterBuyRuntimeEvidence>>['runtime']
    | undefined;
  const facts = await collectOwnedCounterBuyEvidence(
    db,
    owner,
    value,
    signal,
    supplied,
    undefined,
    async (prepared, fee, scope) => {
      const result = await (
        supplied?.runtime ?? collectCounterBuyRuntimeEvidence
      )(prepared, fee, scope);
      runtime = result.runtime;
      return result.simulation;
    },
  );
  signal.throwIfAborted();
  if (
    !runtime ||
    runtime.packetSha256 !== facts.preview.packetSha256 ||
    runtime.simulationSlot !== facts.simulation.simulationSlot ||
    runtime.codeScanCount !== 2 ||
    runtime.codeIdentityObserved !== true ||
    runtime.ordinaryClockVerified !== true ||
    runtime.programCodeAttested !== false ||
    runtime.semanticAuditEstablished !== false ||
    runtime.trustedProgramPolicyEstablished !== false ||
    runtime.innerInstructionPolicyVerified !== false ||
    runtime.signingAllowed !== false ||
    runtime.executionAllowed !== false ||
    !Number.isSafeInteger(runtime.minimumSlot) ||
    !Number.isSafeInteger(runtime.maximumSlot) ||
    runtime.minimumSlot < 0 ||
    runtime.maximumSlot < runtime.minimumSlot ||
    runtime.maximumSlot - runtime.minimumSlot > 32 ||
    !Number.isFinite(Date.parse(runtime.expiresAt)) ||
    Date.parse(runtime.expiresAt) <= Date.now()
  )
    throw new CounterPreviewError(
      'Counter runtime identity differs or expired. No approval was created.',
    );
  return { preview: facts.preview, runtime };
}
export type CounterBudgetPreviewRequest = CounterPreviewRequest & {
  budgetId: string;
  budgetRevision: number;
  strategyId: string;
};
export function counterBudgetPreviewRequest(
  value: unknown,
): CounterBudgetPreviewRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CounterPreviewError(
      'Choose an existing owned Auto Buy budget.',
      400,
    );
  const { budgetId, budgetRevision, strategyId, ...base } =
    value as CounterBudgetPreviewRequest;
  if (
    [budgetId, strategyId].some(
      (v) => typeof v !== 'string' || !UUID.test(v),
    ) ||
    !Number.isSafeInteger(budgetRevision) ||
    budgetRevision < 0 ||
    budgetRevision > 1e9
  )
    throw new CounterPreviewError(
      'Choose exact existing Auto Buy budget revisions.',
      400,
    );
  return {
    ...counterPreviewRequest(base),
    budgetId,
    budgetRevision,
    strategyId,
  };
}
/** Mounted read-only accounting composition. It creates neither budgets nor claims.
 * The original plan is reobserved after simulation; all raw packet/evidence stays
 * module-private. The final rereads are optimistic admission, NOT an atomic hold.
 */
export async function previewOwnedCounterBuyBudget(
  db: D1Database,
  owner: string,
  value: CounterBudgetPreviewRequest,
  signal: AbortSignal,
  supplied?: Dependencies,
) {
  const input = counterBudgetPreviewRequest(value);
  signal = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  try {
    signal.throwIfAborted();
    const budget = await readAutoBuyBudget(db, owner, input.budgetId);
    signal.throwIfAborted();
    if (!budget)
      throw new CounterPreviewError(
        'Owned Auto Buy budget not found. No budget was created.',
        404,
      );
    const terms = budget.terms,
      wallet = terms.wallets.find(
        (w) =>
          w.address === input.wallet && w.revision === input.walletRevision,
      ),
      strategy = terms.strategies.find(
        (s) => s.id === input.strategyId && s.kind === 'Counter',
      ),
      fits = (limit: {
        maximumInputLamports: string;
        maximumFeeAndRentLamports: string;
      }) =>
        BigInt(input.maximumSolInputRaw) <=
          BigInt(limit.maximumInputLamports) &&
        BigInt(input.maximumFeeAndRentRaw) <=
          BigInt(limit.maximumFeeAndRentLamports);
    if (
      budget.state !== 'open' ||
      budget.revision !== input.budgetRevision ||
      terms.projectId !== input.projectId ||
      terms.projectRevision !== input.projectRevision ||
      Date.parse(terms.expiresAt) <= Date.now() ||
      !wallet ||
      !strategy ||
      !fits(terms) ||
      !fits(wallet) ||
      !fits(strategy) ||
      BigInt(input.maximumSolInputRaw) >
        BigInt(budget.remainingInputLamports) ||
      BigInt(input.maximumFeeAndRentRaw) >
        BigInt(budget.remainingFeeAndRentLamports)
    )
      throw new CounterPreviewError(
        'Owned Auto Buy budget, capacity or revisions changed. Request a fresh preview.',
      );
    const {
      budgetId: _budgetId,
      budgetRevision: _budgetRevision,
      strategyId: _strategyId,
      ...base
    } = input;
    const evidence = await collectOwnedCounterBuyEvidence(
      db,
      owner,
      base,
      signal,
      supplied,
      async (plan) => {
        if (
          terms.mint !== plan.ledger.scope.mint ||
          terms.tokenDecimals !== plan.ledger.scope.decimals ||
          strategy.sourceSha256 !==
            (
              await counterAutoBuyCandidateIdentity(
                plan,
                input.decisionIdentity,
              )
            ).sourceSha256
        )
          throw new CounterPreviewError(
            'The owned Counter strategy differs from this Auto Buy budget.',
          );
        signal.throwIfAborted();
        if (
          JSON.stringify(await readAutoBuyBudget(db, owner, input.budgetId)) !==
          JSON.stringify(budget)
        )
          throw new CounterPreviewError(
            'Auto Buy budget changed before provider preparation.',
          );
        signal.throwIfAborted();
      },
    );
    const candidate = await bindCounterAutoBuyAccountingCandidate(
      {
        plan: evidence.plan,
        prepared: evidence.prepared,
        simulation: evidence.simulation,
        settlement: evidence.settlement,
        sourceReview: evidence.sourceReview,
        budget,
        selection: {
          // Ephemeral validator input, never a retained claim or public identifier.
          claimId: crypto.randomUUID(),
          budgetId: input.budgetId,
          budgetRevision: input.budgetRevision,
          strategyId: input.strategyId,
          wallet: input.wallet,
          walletRevision: input.walletRevision,
          now: Date.now(),
        },
      },
      signal,
    );
    const finalSource = await evidence.recheckSource();
    await evidence.unchanged();
    const current = await readAutoBuyBudget(db, owner, input.budgetId);
    signal.throwIfAborted();
    await evidence.unchanged();
    if (
      JSON.stringify(current) !== JSON.stringify(budget) ||
      finalSource.sourceTradeCount !== evidence.sourceReview.sourceTradeCount ||
      Date.parse(finalSource.sourceValidUntil) <
        Date.parse(candidate.claim.expiresAt) ||
      Date.parse(candidate.claim.expiresAt) <= Date.now()
    )
      throw new CounterPreviewError(
        'Auto Buy budget, held accounting or source expiry changed during preview. Request a fresh preview.',
      );
    return {
      format: 'owned-counter-buy-budget-preview-v1' as const,
      scope: 'read-only-nonreservable-preview' as const,
      budgetId: input.budgetId,
      budgetRevision: input.budgetRevision,
      strategyId: input.strategyId,
      projectId: input.projectId,
      projectRevision: input.projectRevision,
      planId: input.planId,
      planRevision: input.planRevision,
      decisionIdentity: input.decisionIdentity,
      wallet: input.wallet,
      walletRevision: input.walletRevision,
      mint: terms.mint,
      tokenDecimals: terms.tokenDecimals,
      inputMint: budget.inputMint,
      packetSha256: evidence.prepared.preparation.sha256,
      outputTargetRaw: evidence.prepared.quote.outputTargetRaw,
      requiredSolInputRaw: evidence.prepared.quote.requiredSolInputRaw,
      maximumQuoteInputRaw: evidence.prepared.quote.maximumSolInputRaw,
      maximumSolInputRaw: input.maximumSolInputRaw,
      maximumFeeAndRentRaw: input.maximumFeeAndRentRaw,
      actualSimulatedInputRaw: evidence.settlement.actualInputRaw,
      networkFeeLamports: evidence.simulation.networkFeeLamports,
      heldInputLamports: budget.heldInputLamports,
      heldFeeAndRentLamports: budget.heldFeeAndRentLamports,
      remainingInputLamports: budget.remainingInputLamports,
      remainingFeeAndRentLamports: budget.remainingFeeAndRentLamports,
      observedAt: evidence.simulation.observedAt,
      sourceTradeCount: finalSource.sourceTradeCount,
      sourceRecheckedAt: finalSource.sourceRecheckedAt,
      sourceValidUntil: finalSource.sourceValidUntil,
      expiresAt: candidate.claim.expiresAt,
      ownerContext: 'rechecked-advisory-only' as const,
      ownershipContextRechecked: true as const,
      budgetContextRechecked: true as const,
      sourceRevalidated: true as const,
      ownerContextVerified: false as const,
      claimStorageEligibilityVerified: false as const,
      accountingCapacityReserved: false as const,
      crossBudgetReplayProtectionVerified: false as const,
      proposalUseReservationVerified: false as const,
      programCodeAttested: false as const,
      reservationCreated: false as const,
      approvalAllowed: false as const,
      signingAllowed: false as const,
      executionAllowed: false as const,
      automaticExecutionAllowed: false as const,
      sourceVerified: false as const,
      instructionsVerified: false as const,
      walletFundsReserved: false as const,
      limitations:
        'Read-only nonreservable preview. Owned context and held totals were rechecked, not locked. No active-claim capacity, cross-budget or global proposal-use reservation, claim-storage eligibility, code admission or execution authority is established. This response cannot be retained as a claim.',
    };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof CounterPreviewError) throw error;
    if (error instanceof AutoBuyBudgetError)
      throw new CounterPreviewError(error.message, error.status);
    if (error instanceof CounterSourceReviewError)
      throw new CounterPreviewError(error.message);
    if (error instanceof AutoBuyCounterCandidateError)
      throw new CounterPreviewError(error.message);
    throw new CounterPreviewError(
      'Counter budget preview unavailable. No budget claim or approval was created.',
      502,
    );
  }
}

export type CounterBudgetPreview = Awaited<
  ReturnType<typeof previewOwnedCounterBuyBudget>
>;
