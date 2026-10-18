import { UUID } from './wallet-operation';
import {
  requireStrategySessionPlan,
  type StrategySessionPlan,
} from './strategy-session-plan';
import { solanaTokenAtoms } from './solana-token-amount';

export type ReviewHold = {
  id: string;
  strategyId: string;
  candidate: number;
  unitsRaw: string;
  state: 'held' | 'released';
  createdAt: string;
  releasedAt: string | null;
};
export const emptyReviewCapacity = () => ({
  format: 'strategy-review-capacity-v1' as const,
  holds: [] as ReviewHold[],
  planningOnly: true as const,
  fundingAllowed: false as const,
  signingAllowed: false as const,
  executionAllowed: false as const,
});
export type ReviewCapacity = ReturnType<typeof emptyReviewCapacity>;
export function reviewInputFits(
  unitsRaw: string,
  remainingRaw: string | null | undefined,
) {
  return remainingRaw == null || BigInt(unitsRaw) <= BigInt(remainingRaw);
}
function fail(): never {
  throw Error('Strategy review capacity differs. Reload before continuing.');
}
export function capacityKeys(value: unknown, keys: string) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys
  )
    fail();
}
export function capacityDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
export async function capacityDigest(value: unknown) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
/** A candidate's immutable input and schedule, not trigger or execution approval. */
export function strategyReviewCandidate(
  plan: StrategySessionPlan,
  strategyId: string,
  candidate: number,
) {
  const index = plan.input.strategies.findIndex((row) => row.id === strategyId),
    row = plan.input.strategies[index];
  if (
    !row ||
    !Number.isSafeInteger(candidate) ||
    candidate < 0 ||
    candidate >= (row.kind === 'DCA' ? row.cycles : 1)
  )
    return fail();
  const unitsRaw = solanaTokenAtoms(
    row.kind === 'DCA' ? row.amountPerCycle : row.amount,
    plan.summary.inputDecimals,
  ).toString();
  const notBefore = new Date(
    Date.parse(plan.input.startAt) +
      (row.kind === 'DCA' ? candidate * row.intervalSeconds * 1000 : 0),
  ).toISOString();
  const endsAt = plan.summary.strategies[index].effectiveEndsAt;
  if (endsAt !== null && notBefore >= endsAt)
    throw Error('This candidate falls outside the reviewed time limits.');
  return {
    strategyId,
    candidate,
    unitsRaw,
    wallet: row.wallet,
    notBefore,
    endsAt,
  };
}
/** Rebuild totals from retained holds with integer atoms, including values above SQL integer precision. */
export function reviewCapacityTotals(
  plan: StrategySessionPlan,
  value: unknown,
) {
  requireStrategySessionPlan(plan);
  capacityKeys(
    value,
    'executionAllowed,format,fundingAllowed,holds,planningOnly,signingAllowed',
  );
  const state = value as ReviewCapacity;
  if (
    state.format !== 'strategy-review-capacity-v1' ||
    state.planningOnly !== true ||
    state.fundingAllowed !== false ||
    state.signingAllowed !== false ||
    state.executionAllowed !== false ||
    !Array.isArray(state.holds) ||
    state.holds.length > 1000
  )
    fail();
  const ids = new Set<string>(),
    active = new Set<string>(),
    held = new Map<string, bigint>();
  for (const h of state.holds) {
    capacityKeys(
      h,
      'candidate,createdAt,id,releasedAt,state,strategyId,unitsRaw',
    );
    if (
      !UUID.test(h.id) ||
      ids.has(h.id) ||
      !capacityDate(h.createdAt) ||
      !['held', 'released'].includes(h.state) ||
      (h.state === 'held'
        ? h.releasedAt !== null
        : !capacityDate(h.releasedAt) || h.releasedAt < h.createdAt)
    )
      fail();
    ids.add(h.id);
    const candidate = strategyReviewCandidate(plan, h.strategyId, h.candidate);
    if (candidate.unitsRaw !== h.unitsRaw) fail();
    if (h.state === 'held') {
      const key = `${h.strategyId}:${h.candidate}`;
      if (active.has(key)) fail();
      active.add(key);
      held.set(
        h.strategyId,
        (held.get(h.strategyId) ?? 0n) + BigInt(h.unitsRaw),
      );
    }
  }
  let total = 0n;
  const strategies = plan.summary.strategies.map((row) => {
    const used = held.get(row.id) ?? 0n,
      cap = row.maximumInputRaw === null ? null : BigInt(row.maximumInputRaw);
    if (cap !== null && used > cap)
      throw Error(
        'This strategy has no remaining input capacity for that candidate.',
      );
    total += used;
    return {
      id: row.id,
      heldRaw: used.toString(),
      remainingRaw: cap === null ? null : (cap - used).toString(),
    };
  });
  const cap =
    plan.summary.maximumInputRaw === null
      ? null
      : BigInt(plan.summary.maximumInputRaw);
  if (cap !== null && total > cap)
    throw Error(
      'The shared input cap is already claimed by other candidates. Release an unused review slot first.',
    );
  return {
    heldRaw: total.toString(),
    remainingRaw: cap === null ? null : (cap - total).toString(),
    strategies,
  };
}
export type ReviewCapacityEvent =
  | { kind: 'hold'; id: string; strategyId: string; candidate: number }
  | { kind: 'release'; id: string };
export function applyReviewCapacity(
  plan: StrategySessionPlan,
  value: ReviewCapacity,
  event: ReviewCapacityEvent,
  now: string,
) {
  reviewCapacityTotals(plan, value);
  capacityKeys(
    event,
    event.kind === 'hold' ? 'candidate,id,kind,strategyId' : 'id,kind',
  );
  if (!UUID.test(event.id) || !capacityDate(now)) fail();
  const state = structuredClone(value),
    previous = state.holds.find((h) => h.id === event.id);
  if (event.kind === 'hold') {
    const candidate = strategyReviewCandidate(
      plan,
      event.strategyId,
      event.candidate,
    );
    if (previous) {
      if (
        previous.strategyId !== event.strategyId ||
        previous.candidate !== event.candidate
      )
        fail();
      return state; // A released ID never acquires capacity again.
    }
    if (candidate.endsAt !== null && now >= candidate.endsAt)
      throw Error(
        'The reviewed time window has ended. Save a new draft copy to review new timing.',
      );
    if (state.holds.length >= 1000)
      throw Error('Review history is full. Save a new draft copy to continue.');
    state.holds.push({
      id: event.id,
      strategyId: event.strategyId,
      candidate: event.candidate,
      unitsRaw: candidate.unitsRaw,
      state: 'held',
      createdAt: now,
      releasedAt: null,
    });
  } else if (event.kind === 'release') {
    if (!previous) fail();
    if (previous.state === 'released') return state;
    if (now < previous.createdAt) fail();
    previous.state = 'released';
    previous.releasedAt = now;
  } else fail();
  reviewCapacityTotals(plan, state);
  return state;
}
