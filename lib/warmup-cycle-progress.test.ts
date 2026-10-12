import { expect, it } from 'vitest';
import {
  warmupCycleProgress,
  type ProgressBuy,
  type ProgressSell,
} from './warmup-cycle-progress';
import type { SavedWarmup } from './wallet-warmup-storage';
const wallet = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const plan: SavedWarmup = {
  id: 'qa',
  revision: 3,
  archived: true,
  updatedAt: '2026-10-11T00:00:00.000Z',
  document: {
    name: 'QA',
    chain: 'Solana',
    addresses: [wallet],
    walletRevisions: [{ address: wallet, revision: 2 }],
    tokens: [mint],
    amount: '0.001',
    feeReserve: '0.01',
    cycles: 2,
    intervalMinutes: 60,
    startAt: '2026-10-11T00:00:00.000Z',
    totalBudget: '0.012',
  },
};
const buy = (patch: Partial<ProgressBuy> = {}): ProgressBuy => ({
  id: 'lot',
  planRevision: 3,
  walletRevision: 2,
  cycle: 1,
  wallet,
  mint,
  acquiredRaw: '18446744073709551615',
  remainingRaw: '18446744073709551615',
  decimals: 6,
  verified: 1,
  commitment: 'finalized',
  network: 'mainnet',
  ...patch,
});
const sell = (consumedRaw: string, buyId = 'lot'): ProgressSell => ({
  buyId,
  consumedRaw,
  verified: 1,
  commitment: 'finalized',
  network: 'mainnet',
});
it('distinguishes no buy, partial sells and full recorded round trips using exact uint64 accounting', () => {
  expect(
    warmupCycleProgress(plan, [], [], [], false).steps.map((row) => row.state),
  ).toEqual(['Not bought', 'Not bought']);
  const partial = warmupCycleProgress(
    plan,
    [buy({ remainingRaw: '18446744073709551515' })],
    [sell('100')],
    [],
    false,
  );
  expect(partial.steps[0]).toMatchObject({
    state: 'Tokens remaining',
    remainingRaw: '18446744073709551515',
    buyCount: 1,
  });
  expect(partial.completedSteps).toBe(0);
  const closed = warmupCycleProgress(
    plan,
    [buy({ remainingRaw: '0' })],
    [sell('18446744073709551615')],
    [],
    false,
  );
  expect(closed.completedSteps).toBe(1);
  expect(closed.steps[0].state).toBe('Recorded lots sold');
});
it('does not mark a cycle sold while any included lot remains and never rounds aggregate units', () => {
  const result = warmupCycleProgress(
    plan,
    [buy(), buy({ id: 'other' })],
    [],
    [],
    false,
  );
  expect(result.steps[0].remainingRaw).toBe('36893488147419103230');
  expect(result.completedSteps).toBe(0);
});
it('requires explicit earlier-revision scope while excluding future and changed token or wallet contexts', () => {
  const lots = [
    buy({ id: 'old', planRevision: 1, walletRevision: 1 }),
    buy({ id: 'future', planRevision: 4 }),
    buy({ id: 'future-wallet', walletRevision: 3 }),
    buy({ id: 'token', mint: wallet }),
    buy({ id: 'wallet', wallet: mint }),
  ];
  expect(warmupCycleProgress(plan, lots, [], [], false).excludedBuys).toBe(5);
  const earlier = warmupCycleProgress(plan, lots, [], [], true);
  expect(earlier.steps[0]).toMatchObject({
    buyCount: 1,
    historicalBuyCount: 1,
  });
  expect(earlier.excludedBuys).toBe(4);
});
it('requires recovery even if the recorded lots are sold or the approval belongs to another plan', () => {
  const result = warmupCycleProgress(
    plan,
    [buy({ remainingRaw: '0' })],
    [sell('18446744073709551615')],
    [{ id: 'pending', wallet, state: 'submitted' }],
    false,
  );
  expect(result.activeApprovals).toBe(1);
  expect(result.completedSteps).toBe(0);
  expect(result.steps.map((row) => row.state)).toEqual([
    'Recovery required',
    'Recovery required',
  ]);
});
it('withholds completion on missing, unfinalized or inconsistent receipt accounting', () => {
  for (const row of [
    buy({ remainingRaw: '0' }),
    buy({ acquiredRaw: '18446744073709551616' }),
    buy({ verified: 0 }),
    buy({ commitment: 'confirmed' }),
  ])
    expect(() => warmupCycleProgress(plan, [row], [], [], false)).toThrow();
  expect(() =>
    warmupCycleProgress(plan, [buy()], [sell('1', 'missing')], [], false),
  ).toThrow();
  expect(() =>
    warmupCycleProgress(
      plan,
      [buy(), buy({ id: 'other', decimals: 9 })],
      [],
      [],
      false,
    ),
  ).toThrow('decimals differ');
});
it('covers all 400 configured wallet cycles without treating empty steps as complete', () => {
  const large = {
    ...plan,
    document: {
      ...plan.document,
      cycles: 20,
      addresses: Array.from({ length: 20 }, (_, i) => String(i)),
      walletRevisions: Array.from({ length: 20 }, (_, i) => ({
        address: String(i),
        revision: 1,
      })),
    },
  };
  expect(warmupCycleProgress(large, [], [], [], false)).toMatchObject({
    completedSteps: 0,
    steps: expect.any(Array),
  });
  expect(warmupCycleProgress(large, [], [], [], false).steps).toHaveLength(400);
});
