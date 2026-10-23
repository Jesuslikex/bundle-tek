import { z } from 'zod';
import {
  AUTO_BUY_BUDGET_AUTHORITY,
  AUTO_BUY_BUDGET_SOL,
  autoBuyBudgetTerms,
  autoBuyBudgetClaim,
  autoBuyBudgetAmount,
} from './auto-buy-budget';
import type { readAutoBuyBudget } from './auto-buy-budget-store';
import { decodeCounterPlan, type CounterPlan } from './counter-trade-store';
import {
  counterProposalSources,
  type reviewCounterBuySources,
} from './counter-source-review';
import type { CounterBuyPreparation } from './counter-buy-preparation';
import {
  reviewCounterBuySettlement,
  type CounterBuySimulation,
} from './counter-buy-settlement';
import { reviewCounterBuyRoute } from './counter-buy-instruction-review';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import { UUID } from './wallet-operation';
import { walletAddress } from './wallet-workspace';

type Budget = NonNullable<Awaited<ReturnType<typeof readAutoBuyBudget>>>;
type Settlement = Awaited<ReturnType<typeof reviewCounterBuySettlement>>;
type SourceReview = Awaited<ReturnType<typeof reviewCounterBuySources>>;
const id = z.string().regex(UUID);
const iso = z
  .string()
  .refine(
    (v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v,
  );
const selectorSchema = z
  .object({
    claimId: id,
    budgetId: id,
    budgetRevision: z.number().int().min(0).max(1e9),
    strategyId: id,
    wallet: z.string(),
    walletRevision: z.number().int().min(1).max(1e9),
    now: z.number().int().min(0).max(8640000000000000),
  })
  .strict();
const sourceSchema = z
  .object({
    sourceTradeCount: z.number().int().min(1).max(1000),
    sourceRecheckedAt: iso,
    sourceValidUntil: iso,
  })
  .strict();
export class AutoBuyCounterCandidateError extends Error {
  constructor() {
    super(
      'The original Counter packet, source or Auto Buy accounting context differs. No funds were reserved or execution authorized.',
    );
  }
}
function fail(): never {
  throw new AutoBuyCounterCandidateError();
}
function uint(value: unknown, positive = false) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n ||
    (positive && value === '0')
  )
    fail();
  return BigInt(value as string);
}
function currentPlan(value: unknown) {
  const plan = decodeCounterPlan(structuredClone(value));
  if (plan.state !== 'active' || plan.rules.responseSide !== 'Buy') fail();
  return plan;
}
/** Stable original rule/proposal identities only, not owned-source admission.
 * Ordinary plan evaluation/requotes do not change these keys. Retained contributors
 * and their existing probability decisions are reused without any new draw.
 */
export async function counterAutoBuyCandidateIdentity(
  value: unknown,
  decisionIdentity: string,
) {
  try {
    const plan = currentPlan(value),
      contributors = counterProposalSources(plan, decisionIdentity);
    const source = {
      format: 'auto-buy-counter-source-v1',
      planId: plan.id,
      projectId: plan.projectId,
      scope: plan.ledger.scope,
      createdAt: plan.createdAt,
      projectDocument: plan.projectDocument,
      rules: plan.rules,
    };
    const sourceSha256 = await digest(canonical(source));
    const candidateKey = await digest(
      canonical({
        format: 'auto-buy-counter-proposal-v1',
        sourceSha256,
        decisionIdentity,
        contributors: contributors.map(({ decision }) => ({
          identity: decision.identity,
          fingerprint: decision.fingerprint,
          outcome: decision.outcome,
          draw: decision.draw,
          contributionTokenRaw: decision.contributionTokenRaw,
          proposalTokenRaw: decision.proposalTokenRaw,
        })),
      }),
    );
    return {
      sourceSha256,
      candidateKey,
      scope: 'counter-accounting-identity-only' as const,
      ...AUTO_BUY_BUDGET_AUTHORITY,
    };
  } catch {
    return fail();
  }
}
export type CounterAutoBuyCandidateInput = {
  plan: CounterPlan;
  prepared: CounterBuyPreparation;
  simulation: CounterBuySimulation;
  settlement: Settlement;
  sourceReview: SourceReview;
  budget: Budget;
  selection: z.infer<typeof selectorSchema>;
};
/** Server-internal, read-only candidate binding. NOT an owned HTTP DTO or claim writer.
 * Every input must come from the original server pipeline and independently selected
 * owned storage. Replaying supplied bytes/observations does not authenticate RPC,
 * finality, current ownership, code identity, funds or durable accounting capacity.
 * The future owned caller MUST run the original reviewCounterBuySources on this
 * SAME plan after simulation, then recheck unchanged owned state. Supplied scalar
 * source summaries are not authenticated evidence of that call.
 * Stable identities alone do not reserve proposal use. 0136 has bounded active
 * same-source/candidate isolation; permanent/global Counter proposal-use admission
 * still requires the original Counter reservation and the eventual atomic writer.
 * There is no database/provider/signer/send call and no new reservation or approval.
 */
export async function bindCounterAutoBuyAccountingCandidate(
  raw: CounterAutoBuyCandidateInput,
  signal: AbortSignal,
) {
  try {
    signal.throwIfAborted();
    // Capture ALL inputs before the first asynchronous packet/source digest.
    const own = structuredClone(raw),
      plan = currentPlan(own.plan),
      prepared = own.prepared;
    const selection = selectorSchema.parse(own.selection),
      source = sourceSchema.parse(own.sourceReview),
      budget = own.budget;
    const terms = autoBuyBudgetTerms(budget.terms),
      scope = plan.ledger.scope,
      quote = prepared.quote;
    for (const key of Object.keys(
      AUTO_BUY_BUDGET_AUTHORITY,
    ) as (keyof typeof AUTO_BUY_BUDGET_AUTHORITY)[])
      if (budget[key] !== false) fail();
    if (selection.now > Date.now()) fail();
    const project = JSON.parse(plan.projectDocument) as {
      token?: { chain?: unknown; address?: unknown; decimals?: unknown };
    } | null;
    if (
      !project ||
      project.token?.chain !== 'Solana' ||
      project.token.address !== scope.mint ||
      project.token.decimals !== scope.decimals
    )
      fail();
    const wallet = walletAddress(selection.wallet, 'Solana');
    if (
      budget.inputMint !== AUTO_BUY_BUDGET_SOL ||
      budget.state !== 'open' ||
      budget.revision !== selection.budgetRevision ||
      terms.id !== selection.budgetId ||
      terms.projectId !== plan.projectId ||
      terms.projectRevision !== scope.revision ||
      terms.mint !== scope.mint ||
      terms.tokenDecimals !== scope.decimals ||
      !plan.rules.ignoredWallets.includes(wallet)
    )
      fail();
    const selectedWallet = terms.wallets.find(
      (w) => w.address === wallet && w.revision === selection.walletRevision,
    );
    const strategy = terms.strategies.find(
      (s) => s.id === selection.strategyId && s.kind === 'Counter',
    );
    if (!selectedWallet || !strategy) fail();
    const decision = plan.ledger.decisions.find(
      (d) => d.identity === quote.decisionIdentity,
    );
    if (
      !decision ||
      decision.outcome !== 'proposal' ||
      decision.proposalTokenRaw === null ||
      prepared.format !== 'counter-buy-preparation-v1' ||
      prepared.executionAllowed !== false ||
      prepared.instructionsVerified !== false ||
      prepared.tokenDecimals !== scope.decimals ||
      prepared.preparation.wallet !== wallet ||
      quote.swapMode !== 'ExactOut' ||
      quote.inputMint !== AUTO_BUY_BUDGET_SOL ||
      quote.outputMint !== terms.mint ||
      quote.outputTargetRaw !== decision.proposalTokenRaw ||
      prepared.expiresAt !== quote.expiresAt ||
      prepared.expiresAt !== prepared.review.expiresAt ||
      prepared.review.wallet !== wallet ||
      prepared.review.projectId !== plan.projectId ||
      prepared.review.projectRevision !== scope.revision ||
      prepared.review.planId !== plan.id ||
      prepared.review.planRevision !== plan.revision ||
      prepared.review.decisionIdentity !== quote.decisionIdentity
    )
      fail();
    // Reuse the original instruction/route evaluator, never a second hand-written decoder.
    const route = reviewCounterBuyRoute(
      plan,
      quote.decisionIdentity,
      quote,
      quote.reviewedSolBudgetRaw,
      wallet,
      own.simulation.instructionReview,
      selection.now,
    );
    if (
      route.assessment.status !== 'Matched fields' ||
      canonical(route.assessment) !== canonical(prepared.review.assessment)
    )
      fail();
    const input = autoBuyBudgetAmount(quote.maximumSolInputRaw, true),
      fee = autoBuyBudgetAmount(own.settlement.reviewedFeeAndRentLimitRaw);
    if (
      input > autoBuyBudgetAmount(quote.reviewedSolBudgetRaw, true) ||
      uint(quote.requiredSolInputRaw, true) > input ||
      uint(decision.proposalTokenRaw, true) !==
        uint(quote.outputTargetRaw, true)
    )
      fail();
    for (const cap of [terms, selectedWallet, strategy])
      if (
        input > autoBuyBudgetAmount(cap.maximumInputLamports, true) ||
        fee > autoBuyBudgetAmount(cap.maximumFeeAndRentLamports)
      )
        fail();
    const held = autoBuyBudgetAmount(budget.heldInputLamports),
      heldFee = autoBuyBudgetAmount(budget.heldFeeAndRentLamports);
    if (
      held + autoBuyBudgetAmount(budget.remainingInputLamports) !==
        autoBuyBudgetAmount(terms.maximumInputLamports) ||
      heldFee + autoBuyBudgetAmount(budget.remainingFeeAndRentLamports) !==
        autoBuyBudgetAmount(terms.maximumFeeAndRentLamports) ||
      input > autoBuyBudgetAmount(budget.remainingInputLamports) ||
      fee > autoBuyBudgetAmount(budget.remainingFeeAndRentLamports) ||
      !Number.isSafeInteger(budget.uncertainClaims) ||
      budget.uncertainClaims < 0
    )
      fail();
    const contributors = counterProposalSources(plan, quote.decisionIdentity);
    if (
      source.sourceTradeCount !== contributors.length ||
      Date.parse(source.sourceRecheckedAt) > selection.now ||
      Date.parse(source.sourceRecheckedAt) <
        Date.parse(own.simulation.observedAt) ||
      Date.parse(source.sourceValidUntil) <= selection.now
    )
      fail();
    for (const { decision: contributor } of contributors) {
      const original = contributor.source!.movement;
      if (
        original.blockTime === null ||
        !Number.isSafeInteger(original.blockTime) ||
        Date.parse(source.sourceValidUntil) >
          Math.min(
            original.blockTime * 1000 + 300000,
            Date.parse(original.observedAt) + 300000,
          )
      )
        fail();
    }
    const proof = await reviewCounterBuySettlement(
      prepared,
      own.simulation,
      fee.toString(),
    );
    signal.throwIfAborted();
    if (canonical(proof) !== canonical(own.settlement)) fail();
    const identity = await counterAutoBuyCandidateIdentity(
      plan,
      quote.decisionIdentity,
    );
    if (strategy.sourceSha256 !== identity.sourceSha256) fail();
    const expiresAt = new Date(
      Math.min(
        Date.parse(prepared.expiresAt),
        Date.parse(source.sourceValidUntil),
        Date.parse(terms.expiresAt),
      ),
    ).toISOString();
    if (
      Date.parse(expiresAt) <= selection.now ||
      Date.parse(expiresAt) <= Date.now()
    )
      fail();
    const claim = autoBuyBudgetClaim({
      id: selection.claimId,
      sessionId: terms.id,
      sessionRevision: budget.revision,
      strategyId: strategy.id,
      wallet,
      walletRevision: selectedWallet.revision,
      candidateKey: identity.candidateKey,
      kind: 'ExactOut',
      minimumOutputTokenRaw: quote.outputTargetRaw,
      sourceSha256: identity.sourceSha256,
      packetSha256: prepared.preparation.sha256,
      maximumInputLamports: input.toString(),
      maximumFeeAndRentLamports: fee.toString(),
      expiresAt,
    });
    signal.throwIfAborted();
    return {
      format: 'auto-buy-counter-accounting-candidate-v1' as const,
      claim,
      suppliedSourceTradeCount: source.sourceTradeCount,
      suppliedSourceRecheckedAt: source.sourceRecheckedAt,
      scope: 'server-internal-accounting-candidate-only' as const,
      ownerContextVerified: false as const,
      accountingCapacityReserved: false as const,
      crossBudgetReplayProtectionVerified: false as const,
      proposalUseReservationVerified: false as const,
      programCodeAttested: false as const,
      ...AUTO_BUY_BUDGET_AUTHORITY,
    };
  } catch {
    signal.throwIfAborted();
    return fail();
  }
}
