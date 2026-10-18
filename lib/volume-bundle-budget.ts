import {
  requireVolumeBundlePlan,
  type VolumeBundlePlan,
} from './volume-bundle-plan';

export type VolumeTipEntry = {
  round: number;
  attemptId: string;
  state: 'reserved' | 'submitted' | 'finalized' | 'cancelled';
  capLamports: string;
  chargedLamports: string;
};
export type VolumeTipBudget = {
  format: 'volume-tip-budget-v1';
  plan: VolumeBundlePlan;
  entries: VolumeTipEntry[];
};
const fail = (): never => {
  throw new Error('Tip budget or attempt transition differs.');
};
/** Pure reducer only. Durable compare-and-swap and verified receipt admission are required before execution. */
export function volumeTipTotals(budget: VolumeTipBudget) {
  const plan = requireVolumeBundlePlan(budget.plan);
  if (
    Object.keys(budget).sort().join(',') !== 'entries,format,plan' ||
    budget.format !== 'volume-tip-budget-v1' ||
    !Array.isArray(budget.entries) ||
    budget.entries.length > 1000
  )
    fail();
  let held = 0n,
    spent = 0n;
  const ids = new Set<string>(),
    active = new Set<number>();
  for (const entry of budget.entries) {
    if (
      Object.keys(entry).sort().join(',') !==
        'attemptId,capLamports,chargedLamports,round,state' ||
      !Number.isSafeInteger(entry.round) ||
      !plan.rounds[entry.round] ||
      typeof entry.attemptId !== 'string' ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(entry.attemptId) ||
      ids.has(entry.attemptId) ||
      entry.capLamports !== plan.rounds[entry.round].tipCapLamports ||
      typeof entry.chargedLamports !== 'string' ||
      !/^(0|[1-9]\d{0,18})$/.test(entry.chargedLamports) ||
      BigInt(entry.chargedLamports) > BigInt(entry.capLamports) ||
      !['reserved', 'submitted', 'finalized', 'cancelled'].includes(entry.state)
    )
      fail();
    ids.add(entry.attemptId);
    if (entry.state !== 'finalized' && entry.chargedLamports !== '0') fail();
    if (entry.state !== 'cancelled') {
      if (active.has(entry.round)) fail();
      active.add(entry.round);
    }
    if (entry.state === 'reserved' || entry.state === 'submitted')
      held += BigInt(entry.capLamports);
    spent += BigInt(entry.chargedLamports);
  }
  const total = BigInt(plan.terms.tipBudgetLamports);
  if (held + spent > total) fail();
  return {
    heldLamports: held.toString(),
    spentLamports: spent.toString(),
    availableLamports: (total - held - spent).toString(),
  };
}
export type VolumeTipEvent =
  | { kind: 'reserve'; round: number; attemptId: string }
  | { kind: 'submitted' | 'cancel'; attemptId: string }
  | { kind: 'finalized'; attemptId: string; chargedLamports: string };
export function applyVolumeTipEvent(
  budget: VolumeTipBudget,
  event: VolumeTipEvent,
) {
  volumeTipTotals(budget);
  if (
    !event ||
    Object.keys(event).sort().join(',') !==
      (event.kind === 'reserve'
        ? 'attemptId,kind,round'
        : event.kind === 'finalized'
          ? 'attemptId,chargedLamports,kind'
          : 'attemptId,kind') ||
    typeof event.attemptId !== 'string'
  )
    fail();
  const next = structuredClone(budget);
  const entry = next.entries.find((e) => e.attemptId === event.attemptId);
  if (event.kind === 'reserve') {
    if (entry) {
      if (entry.round !== event.round || entry.state !== 'reserved') fail();
      return next; // Exact reservation replay, never a second debit.
    }
    const round = next.plan.rounds[event.round];
    if (!Number.isSafeInteger(event.round) || !round) fail();
    next.entries.push({
      round: event.round,
      attemptId: event.attemptId,
      state: 'reserved',
      capLamports: round.tipCapLamports,
      chargedLamports: '0',
    });
  } else {
    if (!entry) return fail();
    if (event.kind === 'cancel') {
      // After a send attempt, timeouts/expiry/missing receipts cannot release tips.
      if (entry.state !== 'reserved' && entry.state !== 'cancelled') fail();
      entry.state = 'cancelled';
    } else if (event.kind === 'submitted') {
      if (entry.state !== 'reserved' && entry.state !== 'submitted') fail();
      entry.state = 'submitted';
    } else if (event.kind === 'finalized') {
      if (
        entry.state !== 'submitted' &&
        !(
          entry.state === 'finalized' &&
          entry.chargedLamports === event.chargedLamports
        )
      )
        fail();
      entry.state = 'finalized';
      entry.chargedLamports = event.chargedLamports;
    } else fail();
  }
  volumeTipTotals(next);
  return next;
}
