import {
  strategyContext,
  strategyInput,
  strategyWallet,
  strategySecond,
} from './strategy-session-fixture';
import { planStrategySession } from '../lib/strategy-session-plan';
import {
  applyReviewCapacity,
  capacityDigest,
  emptyReviewCapacity,
  reviewCapacityTotals,
} from '../lib/strategy-review-capacity';
import type { SavedStrategyDraft } from '../lib/strategy-session-drafts';
export const checkDraftId = '00000000-0000-4000-8000-000000000099',
  checkHoldId = '00000000-0000-4000-8000-000000000098';
export const strategyMarketText = (cap = '1000000000000.000001') =>
  `[{"chainId":"solana","dexId":"pump","pairAddress":"${strategyWallet}","baseToken":{"address":"${strategyContext().token.address}"},"quoteToken":{"address":"${strategySecond}","symbol":"SOL"},"marketCap":${cap}}]`;
export async function strategyCheckFixture(
  kind: 'DCA' | 'Limit' = 'Limit',
  startAt = '2026-10-18T12:00:00.000Z',
) {
  const input = strategyInput();
  input.startAt = startAt;
  const draft: SavedStrategyDraft = {
    id: checkDraftId,
    revision: 1,
    archived: false,
    createdAt: startAt,
    plan: planStrategySession(input, strategyContext()),
  };
  const strategyId = draft.plan.input.strategies.find(
    (s) => s.kind === kind,
  )!.id;
  const state = applyReviewCapacity(
    draft.plan,
    emptyReviewCapacity(),
    { kind: 'hold', id: checkHoldId, strategyId, candidate: 0 },
    startAt,
  );
  const capacity = {
    draftId: draft.id,
    projectId: input.projectId,
    planSha256: await capacityDigest(draft.plan),
    revision: 1,
    state,
    summary: reviewCapacityTotals(draft.plan, state),
    planningOnly: true as const,
    fundingAllowed: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
  return { draft, capacity };
}
