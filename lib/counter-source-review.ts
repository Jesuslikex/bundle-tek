import {
  evaluateCounterTrade,
  validateCounterLedger,
  type CounterDecision,
} from './counter-trade';
import type { CounterPlan } from './counter-trade-store';
import { requirePoolTradeMovement } from './pool-trade-movement';
import { observePoolTradeMovement } from './pool-trade-movement-server';

export class CounterSourceReviewError extends Error {}
const WINDOW_MS = 300000;
/** Every nonzero contribution since the preceding proposal belongs to this target. */
export function counterProposalSources(plan: CounterPlan, identity: string) {
  validateCounterLedger(plan.rules, plan.ledger);
  const end = plan.ledger.decisions.findIndex((d) => d.identity === identity);
  if (
    plan.state !== 'active' ||
    plan.rules.responseSide !== 'Buy' ||
    end < 0 ||
    plan.ledger.decisions[end].outcome !== 'proposal'
  )
    throw new CounterSourceReviewError(
      'Choose an active Counter Buy proposal.',
    );
  let start = end;
  while (start > 0 && plan.ledger.decisions[start - 1].outcome !== 'proposal')
    start--;
  const contributors = plan.ledger.decisions
    .slice(start, end + 1)
    .map((decision, offset) => ({ decision, index: start + offset }))
    .filter(({ decision }) => BigInt(decision.contributionTokenRaw) > 0n);
  if (
    !contributors.length ||
    contributors.some(({ decision }) => !decision.source)
  )
    throw new CounterSourceReviewError(
      'This proposal lacks retained source evidence. Evaluate fresh trades in a new plan.',
    );
  return contributors;
}
function terms(d: CounterDecision) {
  return JSON.stringify([
    d.identity,
    d.fingerprint,
    d.outcome,
    d.draw,
    d.contributionTokenRaw,
    d.proposalTokenRaw,
  ]);
}
/** No rerolled probability, ledger write, packet, approval or signing authority. */
export async function reviewCounterBuySources(
  plan: CounterPlan,
  identity: string,
  signal: AbortSignal,
  observe = observePoolTradeMovement,
) {
  const contributors = counterProposalSources(plan, identity),
    started = Date.now();
  let validUntil = Infinity;
  function fresh(blockTime: number | null, observedAt: string) {
    const now = Date.now(),
      observed = Date.parse(observedAt),
      activation = Date.parse(plan.createdAt);
    if (
      blockTime === null ||
      !Number.isSafeInteger(blockTime) ||
      !Number.isFinite(activation) ||
      !Number.isFinite(observed) ||
      blockTime * 1000 < activation - 1000 ||
      blockTime * 1000 > now + 1000 ||
      now - blockTime * 1000 > WINDOW_MS ||
      observed > now + 1000 ||
      now - observed > WINDOW_MS
    )
      throw new CounterSourceReviewError(
        'A contributing Counter trade is outside its activation or freshness window. Evaluate fresh trades.',
      );
    validUntil = Math.min(
      validUntil,
      blockTime * 1000 + WINDOW_MS,
      observed + WINDOW_MS,
    );
  }
  // Reject incomplete or aged aggregates before any provider call.
  for (const { decision } of contributors) {
    const source = decision.source!;
    fresh(source.movement.blockTime, source.movement.observedAt);
  }
  for (const { decision, index } of contributors) {
    signal.throwIfAborted();
    const source = decision.source!,
      movement = await observe(structuredClone(source.context), signal);
    signal.throwIfAborted();
    try {
      requirePoolTradeMovement(movement, source.context);
      fresh(movement.blockTime, movement.observedAt);
      if (
        movement.blockTime !== source.movement.blockTime ||
        Date.parse(movement.observedAt) < started - 1000
      )
        throw new CounterSourceReviewError(
          'Counter source time or fresh observation differs.',
        );
      let queued = 0n;
      const prefix = plan.ledger.decisions.slice(0, index);
      for (const prior of prefix)
        queued =
          prior.outcome === 'proposal'
            ? 0n
            : queued + BigInt(prior.contributionTokenRaw);
      const result = evaluateCounterTrade(
        plan.rules,
        {
          ...plan.ledger,
          decisions: prefix,
          queuedTokenRaw: queued.toString(),
        },
        movement,
        source.context,
        () => {
          if (decision.draw === null)
            throw new CounterSourceReviewError(
              'Retained Counter probability is unavailable.',
            );
          return decision.draw;
        },
      );
      if (result.replayed || terms(result.decision) !== terms(decision))
        throw new CounterSourceReviewError(
          'A contributing Counter trade changed. Evaluate fresh trades.',
        );
    } catch (error) {
      if (error instanceof CounterSourceReviewError) throw error;
      throw new CounterSourceReviewError(
        'A contributing Counter trade no longer matches its retained evidence.',
      );
    }
  }
  if (validUntil <= Date.now())
    throw new CounterSourceReviewError(
      'Counter sources expired during verification.',
    );
  return {
    sourceTradeCount: contributors.length,
    sourceRecheckedAt: new Date().toISOString(),
    sourceValidUntil: new Date(validUntil).toISOString(),
  };
}
