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
export async function previewOwnedCounterBuy(
  db: D1Database,
  owner: string,
  value: CounterPreviewRequest,
  signal: AbortSignal,
  supplied?: Dependencies,
) {
  const input = counterPreviewRequest(value);
  signal = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  const read = () =>
    db
      .prepare(
        "SELECT p.document AS project_document,p.address AS mint,p.revision AS project_revision,c.document AS plan_document,c.revision AS plan_revision,c.state AS plan_state,w.revision AS wallet_revision,w.role AS wallet_role,w.updated_at AS wallet_updated_at FROM counter_trade_plans c JOIN imported_token_projects p ON p.owner_id=c.owner_id AND p.id=c.project_id JOIN workspace_wallets w ON w.owner_id=c.owner_id AND w.chain='Solana' AND w.address=? WHERE c.owner_id=? AND c.project_id=? AND c.id=? AND c.revision=? AND c.state='active' AND p.chain='Solana' AND p.revision=? AND p.archived=0 AND w.revision=? AND w.archived=0 AND w.role IN ('Recipient','Deployer','Funder') AND EXISTS(SELECT 1 FROM wallet_ownership_proofs o WHERE o.owner_id=c.owner_id AND o.chain='Solana' AND o.address=w.address) AND NOT EXISTS(SELECT 1 FROM wallet_ownership_proofs o WHERE o.owner_id=c.owner_id AND o.chain='Solana' AND NOT EXISTS(SELECT 1 FROM json_each(c.document,'$.rules.ignoredWallets') x WHERE x.value=o.address))",
      )
      .bind(
        input.wallet,
        owner,
        input.projectId,
        input.planId,
        input.planRevision,
        input.projectRevision,
        input.walletRevision,
      )
      .first<Context>();
  signal.throwIfAborted();
  const context = await read();
  if (!context)
    throw new CounterPreviewError(
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
      throw new CounterPreviewError(
        'Counter context changed during the preview. Request a fresh preview.',
      );
    signal.throwIfAborted();
  };
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
    const simulation = await provider.simulate(
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
    return {
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
      expiresAt: prepared.expiresAt,
      ownershipContextRechecked: true as const,
      grossSettlementReviewed: true as const,
      sourceRevalidated: false as const,
      programCodeAttested: false as const,
      reservationCreated: false as const,
      approvalAllowed: false as const,
      signingAllowed: false as const,
      executionAllowed: false as const,
      limitations:
        'Read-only preview of a retained Counter proposal. Fresh trigger-source admission, durable packet/budget storage, reservations, code admission and separate approval/signing/recovery remain required.',
    };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof CounterPreviewError) throw error;
    throw new CounterPreviewError(
      'Counter preparation, simulation or settlement could not be verified. No approval was created.',
      502,
    );
  }
}
