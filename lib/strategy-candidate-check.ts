import type { SavedStrategyDraft } from './strategy-session-drafts';
import type { StrategyCapacityView } from './strategy-capacity-client';
import {
  capacityDate,
  capacityKeys,
  reviewCapacityTotals,
  strategyReviewCandidate,
} from './strategy-review-capacity';
import { exactMarketCap, compareExactMarketCap } from './strategy-exact-usd';
import { solanaTokenAtoms } from './solana-token-amount';
import { walletAddress } from './wallet-workspace';

export type StrategyCheckMarket = {
  source: 'api.dexscreener.com';
  chain: 'Solana';
  address: string;
  observedAt: string;
  returnedPairCount: number;
  quoteOnlyPairCount: number;
  pairs: {
    address: string;
    dex: string;
    quoteSymbol: string;
    marketCapUsd: string | null;
  }[];
};
export function buildStrategyCandidateCheck(
  draft: SavedStrategyDraft,
  capacity: StrategyCapacityView,
  holdId: string,
  checkedAt: string,
  market: StrategyCheckMarket | null,
) {
  if (
    !capacityDate(checkedAt) ||
    draft.archived ||
    capacity.planningOnly !== true ||
    capacity.fundingAllowed !== false ||
    capacity.signingAllowed !== false ||
    capacity.executionAllowed !== false ||
    !/^[a-f0-9]{64}$/.test(capacity.planSha256) ||
    capacity.draftId !== draft.id ||
    capacity.projectId !== draft.plan.input.projectId ||
    capacity.revision < 1 ||
    !Number.isSafeInteger(capacity.revision) ||
    capacity.revision !==
      capacity.state.holds.length +
        capacity.state.holds.filter((h) => h.state === 'released').length ||
    JSON.stringify(reviewCapacityTotals(draft.plan, capacity.state)) !==
      JSON.stringify(capacity.summary)
  )
    throw Error('Candidate review context differs.');
  const hold = capacity.state.holds.find(
    (h) => h.id === holdId && h.state === 'held',
  );
  if (!hold)
    throw Error('The review slot is no longer held. Reload review slots.');
  const candidate = strategyReviewCandidate(
      draft.plan,
      hold.strategyId,
      hold.candidate,
    ),
    terms = draft.plan.input.strategies.find((s) => s.id === hold.strategyId)!;
  const now = Date.parse(checkedAt),
    notBefore = Date.parse(candidate.notBefore),
    end = candidate.endsAt === null ? null : Date.parse(candidate.endsAt);
  const status =
    now < notBefore
      ? 'scheduled'
      : end !== null && now >= end
        ? 'ended'
        : terms.kind === 'DCA'
          ? 'dca-due'
          : 'market-observed';
  if ((status === 'market-observed') !== (market !== null))
    throw Error(
      'Current market observation is required only for a due Limit candidate.',
    );
  const seen = new Set<string>();
  if (market) {
    capacityKeys(
      market,
      'address,chain,observedAt,pairs,quoteOnlyPairCount,returnedPairCount,source',
    );
    if (
      market.source !== 'api.dexscreener.com' ||
      market.chain !== 'Solana' ||
      market.address !== draft.plan.token.address ||
      !capacityDate(market.observedAt) ||
      Date.parse(market.observedAt) > now ||
      Date.parse(market.observedAt) + 30000 <= now ||
      !Number.isSafeInteger(market.returnedPairCount) ||
      market.returnedPairCount < 0 ||
      market.returnedPairCount > 100 ||
      !Number.isSafeInteger(market.quoteOnlyPairCount) ||
      market.quoteOnlyPairCount < 0 ||
      market.quoteOnlyPairCount > market.returnedPairCount ||
      !Array.isArray(market.pairs) ||
      market.pairs.length > 20 ||
      market.pairs.length > market.returnedPairCount - market.quoteOnlyPairCount
    )
      throw Error('Market observation context differs or expired.');
    for (const p of market.pairs) {
      capacityKeys(p, 'address,dex,marketCapUsd,quoteSymbol');
      walletAddress(p.address, 'Solana');
      if (
        seen.has(p.address) ||
        typeof p.dex !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(p.dex) ||
        typeof p.quoteSymbol !== 'string' ||
        p.quoteSymbol.length > 64 ||
        /\p{Cc}/u.test(p.quoteSymbol) ||
        (p.marketCapUsd !== null &&
          exactMarketCap(p.marketCapUsd).text !== p.marketCapUsd)
      )
        throw Error('Market pool differs.');
      seen.add(p.address);
    }
  }
  const pools = (market?.pairs ?? []).map((p) => {
    const comparison =
      p.marketCapUsd === null || p.marketCapUsd === '0'
        ? null
        : compareExactMarketCap(
            p.marketCapUsd,
            solanaTokenAtoms(
              terms.kind === 'Limit' ? terms.marketCapUsd : '1',
              6,
            ),
          );
    return {
      ...p,
      condition:
        comparison === null
          ? ('unavailable' as const)
          : (
                terms.kind === 'Limit' && terms.direction === 'at-or-above'
                  ? comparison >= 0
                  : comparison <= 0
              )
            ? ('met' as const)
            : ('not-met' as const),
    };
  });
  const expiresAt = new Date(
    Math.min(
      now + 30000,
      status === 'scheduled' ? notBefore : Infinity,
      status !== 'ended' && end !== null ? end : Infinity,
      market ? Date.parse(market.observedAt) + 30000 : Infinity,
    ),
  ).toISOString();
  return {
    format: 'strategy-candidate-check-v1' as const,
    draftId: draft.id,
    draftRevision: draft.revision,
    projectId: draft.plan.input.projectId,
    planSha256: capacity.planSha256,
    capacityRevision: capacity.revision,
    holdId,
    ...candidate,
    kind: terms.kind,
    side: draft.plan.input.side,
    checkedAt,
    expiresAt,
    status,
    market: market ? structuredClone(market) : null,
    pools,
    planningOnly: true as const,
    fundingAllowed: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
export type StrategyCandidateCheck = ReturnType<
  typeof buildStrategyCandidateCheck
>;
export function requireStrategyCandidateCheck(
  value: unknown,
  draft: SavedStrategyDraft,
  capacity: StrategyCapacityView,
  holdId: string,
) {
  const v = value as StrategyCandidateCheck;
  if (!v || v.holdId !== holdId)
    throw Error('Candidate check belongs to a different review slot.');
  const rebuilt = buildStrategyCandidateCheck(
    draft,
    capacity,
    holdId,
    v.checkedAt,
    v.market,
  );
  if (JSON.stringify(rebuilt) !== JSON.stringify(v))
    throw Error('Candidate check response differs.');
  return rebuilt;
}
