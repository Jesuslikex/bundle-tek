import { expect, it } from 'vitest';
import {
  planVolumeSession,
  requireVolumePlan,
  VOLUME_LIMITS,
  type VolumeTerms,
} from './volume-bot-plan';

const wallets = [
  '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
  '8phnoC6V8nwYnNUwobNBoWzWAmyP1nj9GyYZaMbU8z4',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'So11111111111111111111111111111111111111112',
];
const rich = wallets.map((address) => ({
  address,
  lamports: '10000000000',
}));
const seed = '0123456789abcdef0123456789abcdef';
const terms = (over: Partial<VolumeTerms> = {}): VolumeTerms => ({
  targetVolumeLamports: '2000000000',
  durationSeconds: 3600,
  delayMinMs: 5_000,
  delayMaxMs: 15_000,
  amount: { kind: 'fixed', lamports: '100000000' },
  wave: 'tight',
  wallets,
  ...over,
});

function invariants(plan: ReturnType<typeof planVolumeSession>) {
  const buyBatch = new Map<number, number>();
  const open = new Set<string>();
  for (const event of plan.events) {
    if (event.side === 'Buy') {
      expect(open.has(event.wallet)).toBe(false);
      open.add(event.wallet);
      buyBatch.set(event.round, event.batch);
    } else {
      // A sell always comes in a later batch than its own buy.
      expect(event.batch).toBeGreaterThan(buyBatch.get(event.round)!);
      open.delete(event.wallet);
    }
    expect(event.batchOffsetMs).toBeGreaterThanOrEqual(0);
    expect(event.batchOffsetMs).toBeLessThanOrEqual(VOLUME_LIMITS.batchSpanMs);
  }
  expect(open.size).toBe(0);
  for (let batch = 0; batch < plan.batches; batch++) {
    const members = plan.events.filter((e) => e.batch === batch);
    expect(members.length).toBeGreaterThan(0);
    expect(new Set(members.map((e) => e.wallet)).size).toBe(members.length);
  }
  for (let n = 1; n < plan.events.length; n++)
    expect(plan.events[n].offsetMs).toBeGreaterThanOrEqual(
      plan.events[n - 1].offsetMs,
    );
}

it('plans fixed-size round trips that reach the target volume', () => {
  const plan = planVolumeSession(terms(), rich, seed);
  expect(plan.estimate.rounds).toBe(10);
  expect(plan.estimate.trades).toBe(20);
  expect(BigInt(plan.estimate.volumeLamports)).toBe(2_000_000_000n);
  expect(plan.estimate.approvals).toBe(plan.batches);
  expect(plan.signingAllowed).toBe(false);
  invariants(plan);
});

it('is deterministic for one seed and differs for another', () => {
  expect(planVolumeSession(terms(), rich, seed)).toEqual(
    planVolumeSession(terms(), rich, seed),
  );
  const other = planVolumeSession(
    terms(),
    rich,
    'fedcba9876543210fedcba9876543210',
  );
  expect(other.events.map((e) => e.offsetMs)).not.toEqual(
    planVolumeSession(terms(), rich, seed).events.map((e) => e.offsetMs),
  );
});

it('tight alternates each buy with its own sell; big waves make streaks', () => {
  const tight = planVolumeSession(terms(), rich, seed);
  expect(tight.events.map((e) => e.side).slice(0, 6)).toEqual([
    'Buy',
    'Sell',
    'Buy',
    'Sell',
    'Buy',
    'Sell',
  ]);
  const waves = planVolumeSession(terms({ wave: 'big-waves' }), rich, seed);
  const sides = waves.events.map((e) => e.side).join('');
  expect(sides).toMatch(/BuyBuy/);
  expect(sides).toMatch(/SellSell/);
  invariants(waves);
});

it('random amounts stay inside the range and cover the target', () => {
  const plan = planVolumeSession(
    terms({
      amount: {
        kind: 'range',
        minLamports: '50000000',
        maxLamports: '150000000',
      },
      wave: 'big-waves',
    }),
    rich,
    seed,
  );
  for (const round of plan.rounds) {
    expect(BigInt(round.lamports)).toBeGreaterThanOrEqual(50_000_000n);
    expect(BigInt(round.lamports)).toBeLessThanOrEqual(150_000_000n);
  }
  expect(BigInt(plan.estimate.volumeLamports)).toBeGreaterThanOrEqual(
    2_000_000_000n,
  );
  invariants(plan);
});

it('auto sizing spreads the exact target across the duration', () => {
  const plan = planVolumeSession(
    terms({ amount: { kind: 'auto' }, durationSeconds: 600 }),
    rich,
    seed,
  );
  expect(plan.estimate.volumeLamports).toBe('2000000000');
  expect(plan.estimate.scheduledSeconds).toBeLessThanOrEqual(600);
  expect(plan.estimate.rounds).toBeGreaterThan(10);
  invariants(plan);
});

it('excludes underfunded wallets when others remain, refuses when none can trade', () => {
  const balances = rich.map((b, n) => ({
    ...b,
    lamports: n === 1 ? '1000' : b.lamports,
  }));
  const plan = planVolumeSession(terms(), balances, seed);
  expect(plan.excludedWallets).toEqual([wallets[1]]);
  expect(plan.events.some((e) => e.wallet === wallets[1])).toBe(false);
  expect(() =>
    planVolumeSession(
      terms(),
      rich.map((b) => ({ ...b, lamports: '1000' })),
      seed,
    ),
  ).toThrow(/No selected wallet/);
  expect(() => planVolumeSession(terms(), rich.slice(1), seed)).toThrow(
    /Observe every selected wallet/,
  );
});

it('refuses a schedule that cannot fit the duration and states the minimum', () => {
  expect(() =>
    planVolumeSession(terms({ durationSeconds: 60 }), rich, seed),
  ).toThrow(/needs at least \d+ seconds/);
});

it('rejects malformed terms and too many rounds', () => {
  expect(() =>
    planVolumeSession(terms({ delayMaxMs: 1_000 }), rich, seed),
  ).toThrow(/maximum delay/);
  expect(() =>
    planVolumeSession(
      { ...terms(), extra: 1 } as unknown as VolumeTerms,
      rich,
      seed,
    ),
  ).toThrow(/unknown fields/);
  expect(() =>
    planVolumeSession(
      terms({
        targetVolumeLamports: '1000000000000',
        amount: { kind: 'fixed', lamports: '1000000' },
        durationSeconds: 86_400,
      }),
      rich,
      seed,
    ),
  ).toThrow(/more than 250 round trips/);
  expect(() =>
    planVolumeSession(terms({ wallets: [wallets[0], wallets[0]] }), rich, seed),
  ).toThrow(/distinct/);
});

it('rebuilds a saved plan and refuses one edited after estimate', () => {
  const plan = planVolumeSession(terms(), rich, seed);
  expect(requireVolumePlan(plan, rich)).toEqual(plan);
  const edited = structuredClone(plan);
  edited.events[0].wallet = wallets[3];
  expect(() => requireVolumePlan(edited, rich)).toThrow(/plan changed/);
});
