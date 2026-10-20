import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { warmupSessionReviewFixture } from '@/test/warmup-session-review-fixture';
import { warmupCycleProgress } from './warmup-cycle-progress';
import {
  warmupLotPerformance,
  type PerformanceBuy,
} from './warmup-lot-performance';
import { reviewWalletWarmupSession } from './wallet-warmup-session-review';
import {
  WalletWarmupSessionSequence as Sequence,
  WARMUP_SESSION_REVIEW_GAP_MS as GAP,
} from './wallet-warmup-session-sequence';
const now = Date.parse('2026-10-21T00:00:00.000Z');
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function setup(cycles = 2) {
  const f = warmupSessionReviewFixture(now, cycles),
    body = f.response(now);
  return { ...f, body, sequence: new Sequence(body, f.plan, now) };
}
function event(take: ReturnType<Sequence['beginReview']>, n = 1) {
  const a = take.action;
  return {
    actionId: a.id,
    planId: 'synthetic-session',
    planRevision: 1,
    wallet: a.wallet,
    walletRevision: a.walletRevision,
    mint: a.mint,
    receiptId: id(n),
    network: 'mainnet' as const,
    commitment: 'finalized' as const,
    verified: true as const,
    networkFeeLamports: '5000',
    rentChangeLamports: '0',
    ...(a.side === 'Buy'
      ? {
          side: 'Buy' as const,
          inputLamports: a.inputLamports,
          acquiredRaw: '1000',
          decimals: 6,
        }
      : {
          side: 'Sell' as const,
          buyReceiptId: take.sellSource!.buyReceiptId,
          consumedRaw: take.sellSource!.remainingRaw,
        }),
  };
}
beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No provider requests permitted');
    }),
  ),
);
afterEach(() => vi.unstubAllGlobals());
it('replays the exact reviewed plan, owns nested values and grants no execution authority', () => {
  const f = setup(),
    s = f.sequence;
  f.body.review.actions[0].wallet = 'changed';
  const snapshot = s.snapshot(now);
  expect(snapshot).toMatchObject({
    phase: 'review-required',
    executionAllowed: false,
    signingAllowed: false,
    automaticExecutionAllowed: false,
  });
  const take = s.beginReview(now),
    original = take.action.id;
  take.action.wallet = 'changed';
  expect(s.snapshot(now).pending?.action.wallet).toBe(
    f.plan.document.addresses[0],
  );
  expect(() => s.recordSubmission(original, now)).not.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it('reserves only one review, cannot record submission twice and requires a recorded submission before settlement', () => {
  const s = setup().sequence,
    take = s.beginReview(now);
  expect(() => s.beginReview(now)).toThrow();
  expect(() => s.recordFinalized(event(take), now)).toThrow();
  s.recordSubmission(take.action.id, now);
  expect(() => s.recordSubmission(take.action.id, now)).toThrow();
  expect(s.snapshot(now).completedActions).toBe(0);
});
it('links a future sell to its finalized buy and serializes overdue actions without catch-up bursts', () => {
  const s = setup().sequence;
  for (let n = 0; n < 4; n++) {
    const at = now + n * (GAP + 2),
      take = s.beginReview(at),
      record = event(take, n + 1);
    if (n % 2 === 1)
      expect(take.sellSource).toEqual({
        buyReceiptId: id(n),
        remainingRaw: '1000',
        decimals: 6,
      });
    s.recordSubmission(take.action.id, at + 1);
    s.recordFinalized(record, at + 2);
    if (n < 3) {
      expect(s.snapshot(at + 2).phase).toBe('waiting');
      expect(() => s.beginReview(at + GAP + 1)).toThrow();
    }
  }
  expect(s.snapshot(now + 3 * (GAP + 2) + 2)).toMatchObject({
    phase: 'complete',
    completedActions: 4,
    totalActions: 4,
  });
});
it('does not advance uncertain outcomes and can record exact finalization through recovery', () => {
  const s = setup().sequence,
    take = s.beginReview(now),
    record = event(take);
  s.recordSubmission(take.action.id, now);
  s.requireRecovery(take.action.id, now + 1);
  expect(s.snapshot(now + 1).phase).toBe('recovery-required');
  expect(() => s.beginReview(now + 2)).toThrow();
  expect(s.recordFinalized(record, now + 2).completedActions).toBe(1);
});
it('pause and stop never discard an observation arriving from an already in-flight operation', () => {
  const s = setup().sequence,
    take = s.beginReview(now);
  s.pause(now);
  expect(() => s.beginReview(now)).toThrow();
  s.recordSubmission(take.action.id, now);
  s.stop(now);
  const settled = s.recordFinalized(event(take), now + 1);
  expect(settled).toMatchObject({
    phase: 'stopped',
    completedActions: 1,
    stopped: true,
  });
  expect(() => s.resume(now + 2)).toThrow();
  expect(() => s.beginReview(now + 2)).toThrow();
});
it('retains elapsed clocks during pause and refuses new reviews after source expiry without blocking old receipt recovery', () => {
  const s = setup().sequence,
    take = s.beginReview(now);
  s.pause(now + 1);
  s.resume(now + 2);
  s.requireRecovery(take.action.id, now + 3);
  const state = s.recordFinalized(event(take), now + 60000);
  expect(state).toMatchObject({
    phase: 'refresh-required',
    sourceReviewFresh: false,
    completedActions: 1,
  });
  expect(() => s.beginReview(now + 60000)).toThrow();
});
it('waits for a future captured schedule without rebasing it after pause', () => {
  const f = warmupSessionReviewFixture(now, 1);
  f.plan.document.startAt = new Date(now + 1000).toISOString();
  const s = new Sequence(f.response(now), f.plan, now);
  expect(s.snapshot(now).phase).toBe('waiting');
  s.pause(now + 1);
  s.resume(now + 2);
  expect(() => s.beginReview(now + 999)).toThrow();
  expect(s.beginReview(now + 1000).action.scheduledAt).toBe(
    f.plan.document.startAt,
  );
});
it.each([
  'wallet',
  'walletRevision',
  'mint',
  'planId',
  'planRevision',
  'actionId',
  'network',
  'commitment',
  'verified',
  'inputLamports',
  'acquiredRaw',
  'receiptId',
  'extra',
])(
  'refuses changed or invalid settlement %s without consuming the action or reserve',
  (field) => {
    const s = setup().sequence,
      take = s.beginReview(now),
      record = event(take),
      bad: Record<string, unknown> = { ...record };
    if (field === 'extra') bad.extra = true;
    else if (field === 'walletRevision' || field === 'planRevision')
      bad[field] = 2;
    else if (field === 'verified') bad[field] = false;
    else if (field === 'inputLamports') bad[field] = '999';
    else if (field === 'acquiredRaw') bad[field] = '0';
    else bad[field] = 'changed';
    s.recordSubmission(take.action.id, now);
    expect(() => s.recordFinalized(bad, now)).toThrow();
    expect(s.snapshot(now).wallets[0].recordedFurtherFeeRentLamports).toBe('0');
    expect(s.recordFinalized(record, now).completedActions).toBe(1);
  },
);
it('replays identical finalized events idempotently and refuses changed replays or a duplicate receipt for another action', () => {
  const s = setup().sequence,
    buy = s.beginReview(now),
    record = event(buy);
  s.recordSubmission(buy.action.id, now);
  const first = s.recordFinalized(record, now);
  expect(s.recordFinalized(record, now)).toEqual(first);
  expect(() =>
    s.recordFinalized({ ...record, networkFeeLamports: '5001' }, now),
  ).toThrow();
  const sell = s.beginReview(now + GAP);
  s.recordSubmission(sell.action.id, now + GAP);
  expect(() => s.recordFinalized(event(sell, 1), now + GAP)).toThrow();
});
it('requires exact remaining buy units for a sell and refuses a different lot', () => {
  const s = setup().sequence,
    buy = s.beginReview(now);
  s.recordSubmission(buy.action.id, now);
  s.recordFinalized(event(buy), now);
  const sell = s.beginReview(now + GAP);
  s.recordSubmission(sell.action.id, now + GAP);
  const record = event(sell, 2);
  expect(() =>
    s.recordFinalized({ ...record, consumedRaw: '999' }, now + GAP),
  ).toThrow();
  expect(() =>
    s.recordFinalized({ ...record, buyReceiptId: id(99) }, now + GAP),
  ).toThrow();
  expect(s.recordFinalized(record, now + GAP).completedActions).toBe(2);
});
it('charges fees and positive rent against the original remaining reserve and never credits refunds', () => {
  const s = setup().sequence,
    take = s.beginReview(now),
    record = event(take);
  s.recordSubmission(take.action.id, now);
  expect(() =>
    s.recordFinalized({ ...record, networkFeeLamports: '10000001' }, now),
  ).toThrow();
  expect(
    s.recordFinalized({ ...record, rentChangeLamports: '-9000000' }, now)
      .wallets[0],
  ).toMatchObject({
    recordedFurtherBuySpendLamports: '1000000',
    recordedFurtherFeeRentLamports: '5000',
    remainingReserveLamports: '9995000',
  });
});
it('uses exact retained saved-buy units without inventing a new buy or increasing its reserve', () => {
  const f = warmupSessionReviewFixture(now, 1),
    wallet = f.plan.document.addresses[0],
    mint = f.plan.document.tokens[0];
  const buy: PerformanceBuy = {
    id: id(1),
    planRevision: 1,
    walletRevision: 1,
    cycle: 1,
    wallet,
    mint,
    acquiredRaw: '1000',
    remainingRaw: '1000',
    decimals: 6,
    verified: 1,
    commitment: 'finalized',
    network: 'mainnet',
    document: {
      signature: bs58.encode(new Uint8Array(64).fill(1)),
      wallet,
      mint,
      decimals: 6,
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      slot: 1,
      preparationSha256: 'a'.repeat(64),
      nativeSettlementRaw: '-1000000',
      networkFeeLamports: '5000',
      rentChangeRaw: '0',
    },
  };
  const progress = warmupCycleProgress(f.plan, [buy], [], [], false),
    performance = warmupLotPerformance([buy], [], [buy.id]);
  const body = {
    review: reviewWalletWarmupSession(f.plan, progress, performance, now),
    reviewExpiresAt: new Date(now + 60000).toISOString(),
  };
  const s = new Sequence(body, f.plan, now);
  expect(s.snapshot(now).totalActions).toBe(1);
  const take = s.beginReview(now + 5000);
  expect(take.action.side).toBe('Sell');
  expect(take.sellSource?.buyReceiptId).toBe(buy.id);
  s.recordSubmission(take.action.id, now + 5000);
  expect(() => s.recordFinalized(event(take, 1), now + 5000)).toThrow();
  expect(
    s.recordFinalized(event(take, 2), now + 5000).wallets[0]
      .remainingReserveLamports,
  ).toBe('9990000');
});
it.each([now - 1, -1, NaN, Number.MAX_SAFE_INTEGER])(
  'refuses invalid or backward local clocks %s',
  (clock) => {
    expect(() => setup().sequence.snapshot(clock)).toThrow();
  },
);
it('refuses altered authority or expired review input without creating a sequence', () => {
  const f = setup();
  Object.assign(f.body.review, { signingAllowed: true });
  expect(() => new Sequence(f.body, f.plan, now)).toThrow();
  expect(() => new Sequence(f.response(now), f.plan, now + 60000)).toThrow();
});
