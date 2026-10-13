import { decodeCounterPlan, type CounterPlan } from './counter-trade-store';
import type { CounterBuyTargetQuote } from './counter-buy-quote';
import type { SwapInstructionReview } from './swap-instruction-review';
import { assessJupiterExactOutRoute } from './jupiter-exact-out-assessment';
import { WRAPPED_SOL } from './warmup-swap-quote';

/** Bind instruction inspection to the retained decision and independently reviewed budget. */
export function reviewCounterBuyRoute(
  value: CounterPlan,
  identity: string,
  quote: CounterBuyTargetQuote,
  reviewedSolBudgetRaw: string,
  wallet: string,
  instructions: SwapInstructionReview,
  now = Date.now(),
) {
  const plan = decodeCounterPlan(structuredClone(value));
  const decision = plan.ledger.decisions.find((d) => d.identity === identity);
  const observed = Date.parse(quote?.observedAt),
    expires = Date.parse(quote?.expiresAt);
  if (
    plan.state !== 'active' ||
    plan.rules.responseSide !== 'Buy' ||
    decision?.outcome !== 'proposal' ||
    decision.proposalTokenRaw === null ||
    quote?.format !== 'counter-buy-target-quote-v1' ||
    quote.executionAllowed !== false ||
    quote.projectId !== plan.projectId ||
    quote.projectRevision !== plan.ledger.scope.revision ||
    quote.planId !== plan.id ||
    quote.planRevision !== plan.revision ||
    quote.decisionIdentity !== identity ||
    quote.inputMint !== WRAPPED_SOL ||
    quote.outputMint !== plan.ledger.scope.mint ||
    quote.outputTargetRaw !== decision.proposalTokenRaw ||
    quote.swapMode !== 'ExactOut' ||
    quote.slippageBps !== 50 ||
    quote.source !== 'api.jup.ag' ||
    quote.reviewedSolBudgetRaw !== reviewedSolBudgetRaw ||
    !Number.isSafeInteger(quote.contextSlot) ||
    quote.contextSlot < 0 ||
    !Number.isFinite(now) ||
    !Number.isFinite(observed) ||
    !Number.isFinite(expires) ||
    observed > now ||
    expires <= now ||
    expires <= observed ||
    expires - observed > 30000
  )
    throw new Error('Counter Buy review context changed or expired.');
  const assessment = assessJupiterExactOutRoute(instructions, {
    swapMode: 'ExactOut',
    wallet,
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    quotedInputRaw: quote.requiredSolInputRaw,
    outputTargetRaw: quote.outputTargetRaw,
    maximumInputRaw: quote.maximumSolInputRaw,
    reviewedInputBudgetRaw: reviewedSolBudgetRaw,
    slippageBps: quote.slippageBps,
  });
  return {
    format: 'counter-buy-instruction-review-v1' as const,
    executionAllowed: false as const,
    projectId: plan.projectId,
    projectRevision: plan.ledger.scope.revision,
    planId: plan.id,
    planRevision: plan.revision,
    decisionIdentity: identity,
    wallet,
    expiresAt: quote.expiresAt,
    assessment,
    limitations:
      'Proposal-bound instruction inspection only. Current database/project/wallet context, source freshness, durable proposal-use reservation, token ownership/extensions, wrapping, aggregate debits, simulation and explicit user approval remain required before signing.',
  };
}
