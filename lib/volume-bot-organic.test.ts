import { expect, it, describe } from 'vitest';
import {
  planVolumeSession,
  requireVolumePlan,
  volumeTerms,
  VOLUME_LIMITS,
  type VolumeTerms,
} from './volume-bot-plan';

const wallets = [
  '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
  '8phnoC6V8nwYnNUwobNBoWzWAmyP1nj9GyYZaMbU8z4',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'So11111111111111111111111111111111111111112',
];
const rich = wallets.map((address) => ({ address, lamports: '10000000000' }));
const seed = '0123456789abcdef0123456789abcdef';
/** Legacy shape: a duration and a delay pair, no end condition. */
const terms = (over: Partial<VolumeTerms> = {}): VolumeTerms => ({
  targetVolumeLamports: '2000000000',
  durationSeconds: 3600,
  delayMinMs: 5_000,
  delayMaxMs: 15_000,
  amount: { kind: 'auto' },
  wave: 'tight',
  wallets,
  ...over,
});
/** Proxima's duration end condition: no delays, no amount. */
const timed = (over: Partial<VolumeTerms> = {}): VolumeTerms => ({
  targetVolumeLamports: '2000000000',
  endCondition: 'time',
  durationSeconds: 3600,
  wave: 'tight',
  wallets,
  ...over,
});
/** Proxima's delay end condition: a delay pair and a required amount. */
const delayed = (over: Partial<VolumeTerms> = {}): VolumeTerms => ({
  targetVolumeLamports: '2000000000',
  endCondition: 'delay',
  delayMinMs: 5_000,
  delayMaxMs: 15_000,
  amount: { kind: 'fixed', lamports: '100000000' },
  wave: 'tight',
  wallets,
  ...over,
});

describe('volume plan modes', () => {
  it('defaults to Organic and leaves the field off the terms', () => {
    const plan = planVolumeSession(terms(), rich, seed);
    expect(plan.terms).not.toHaveProperty('mode');
    expect(plan.terms).not.toHaveProperty('waveIntensityTenths');
    expect(plan.estimate.scheduledSeconds).toBeGreaterThan(0);
    expect(plan.events.length).toBeGreaterThan(0);
  });

  it('spreads delay trades by the sampled delays', () => {
    const plan = planVolumeSession(delayed(), rich, seed);
    const offsets = plan.events.map((event) => event.offsetMs);
    for (let n = 1; n < offsets.length; n++)
      expect(offsets[n]).toBeGreaterThanOrEqual(offsets[n - 1]);
    expect(new Set(plan.events.map((event) => event.batch)).size).toBeGreaterThan(
      1,
    );
  });

  it('lands every bundle buy and sell in the same block', () => {
    const plan = planVolumeSession(delayed({ mode: 'Bundle' }), rich, seed);
    expect(plan.terms.mode).toBe('Bundle');
    const pairs = new Map<number, Set<string>>();
    for (const event of plan.events) {
      const sides = pairs.get(event.batch) ?? new Set<string>();
      sides.add(event.side);
      pairs.set(event.batch, sides);
    }
    for (const sides of pairs.values()) expect(sides.size).toBe(2);
  });

  it('spreads a duration schedule evenly and ends inside it', () => {
    const plan = planVolumeSession(timed(), rich, seed);
    const offsets = plan.events.map((event) => event.offsetMs);
    const gaps = offsets.slice(1).map((offset, n) => offset - offsets[n]);
    expect(new Set(gaps).size).toBe(1);
    expect(offsets.at(-1)).toBeLessThanOrEqual(3600 * 1000);
    // The target still lands exactly, split into equal round trips.
    expect(plan.estimate.volumeLamports).toBe('2000000000');
    expect(new Set(plan.rounds.map((round) => round.lamports)).size).toBe(1);
  });

  it('honours a reviewed random amount range', () => {
    const plan = planVolumeSession(
      delayed({
        amount: {
          kind: 'range',
          minLamports: '50000000',
          maxLamports: '150000000',
        },
      }),
      rich,
      seed,
    );
    for (const round of plan.rounds) {
      expect(BigInt(round.lamports)).toBeGreaterThanOrEqual(50_000_000n);
      expect(BigInt(round.lamports)).toBeLessThanOrEqual(150_000_000n);
    }
    // A reviewed range is a per-trade bound, not an exact total: the plan draws
    // inside it and the volume lands near the target rather than on it.
    expect(BigInt(plan.estimate.volumeLamports)).toBeGreaterThan(0n);
  });

  it('repeats a reviewed fixed amount on every round', () => {
    const plan = planVolumeSession(delayed(), rich, seed);
    expect(new Set(plan.rounds.map((round) => round.lamports)).size).toBe(1);
    expect(plan.rounds[0].lamports).toBe('100000000');
  });

  it('keeps auto sizes inside the trade limits and lands the target', () => {
    const plan = planVolumeSession(terms(), rich, seed);
    expect(plan.estimate.volumeLamports).toBe('2000000000');
    for (const round of plan.rounds) {
      expect(BigInt(round.lamports)).toBeGreaterThanOrEqual(
        VOLUME_LIMITS.minTradeLamports,
      );
      expect(BigInt(round.lamports)).toBeLessThanOrEqual(
        VOLUME_LIMITS.maxTradeLamports,
      );
    }
  });

  it('is deterministic from the seed and survives a rebuild check', () => {
    const input = delayed({
      mode: 'Organic',
      wave: 'big-waves',
      waveIntensityTenths: 4,
    });
    const once = planVolumeSession(input, rich, seed);
    expect(planVolumeSession(input, rich, seed)).toEqual(once);
    expect(requireVolumePlan(once, rich)).toEqual(once);
  });

  it('rebuilds a plan saved while organic still carried its own settings', () => {
    const legacy = terms({
      organic: { amountJitterPercent: 30, shuffleWallets: true },
    });
    const plan = planVolumeSession(legacy, rich, seed);
    expect(plan.terms.organic).toEqual({
      amountJitterPercent: 30,
      shuffleWallets: true,
    });
    expect(requireVolumePlan(plan, rich)).toEqual(plan);
  });

  it('validates the mode and wave intensity strictly', () => {
    const base = delayed();
    expect(volumeTerms({ ...base, mode: 'Organic' }).mode).toBe('Organic');
    expect(volumeTerms({ ...base, mode: 'Bundle' }).mode).toBe('Bundle');
    expect(() => volumeTerms({ ...base, mode: 'organic' })).toThrow(/mode/i);
    expect(() => volumeTerms({ ...base, waveIntensityTenths: 11 })).toThrow(
      /intensity/i,
    );
    expect(() =>
      volumeTerms({ ...base, waveIntensityTenths: 3, wave: 'tight' }),
    ).toThrow(/differs/i);
  });

  it('keeps duration and delay end conditions exclusive', () => {
    // Proxima only sends delays in Delay mode and only a duration in Duration
    // mode, so a stray field is a stale form rather than a setting.
    expect(() =>
      volumeTerms({ ...delayed(), durationSeconds: 600 }),
    ).toThrow(/no duration/i);
    expect(() =>
      volumeTerms({ ...timed(), delayMinMs: 1_000, delayMaxMs: 2_000 }),
    ).toThrow(/no delays/i);
    expect(() => volumeTerms({ ...timed(), amount: { kind: 'auto' } })).toThrow(
      /no amount/i,
    );
    expect(() =>
      volumeTerms({ ...delayed(), amount: undefined }),
    ).toThrow(/trade amounts/i);
  });

  it('rejects a delay pair that is out of order or over five minutes', () => {
    expect(() =>
      volumeTerms({ ...delayed(), delayMinMs: 9_000, delayMaxMs: 2_000 }),
    ).toThrow(/min delay and max delay/i);
    expect(() =>
      volumeTerms({ ...delayed(), delayMinMs: 1_000, delayMaxMs: 300_001 }),
    ).toThrow(/min delay and max delay/i);
  });
});
