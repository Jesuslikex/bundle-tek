import { describe, expect, it } from 'vitest';
import { planVolumeSession, VolumePlanError, type VolumeTerms } from './volume-bot-plan';

const wallets = [
  '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
  '8phnoC6V8nwYnNUwobNBoWzWAmyP1nj9GyYZaMbU8z4',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
];
const rich = wallets.map((address) => ({ address, lamports: '10000000000' }));
const seed = '0123456789abcdef0123456789abcdef';
const base: VolumeTerms = {
  targetVolumeLamports: '10000000',
  durationSeconds: 3600,
  delayMinMs: 5_000,
  delayMaxMs: 15_000,
  amount: { kind: 'fixed', lamports: '1000000' },
  wave: 'tight',
  wallets,
};

describe('volume bundle mode', () => {
  it('sells in the same block and batch as its own buy', () => {
    const plan = planVolumeSession({ ...base, mode: 'Bundle' }, rich, seed);
    const byRound = new Map<number, { buy: number; sell: number; batch: number }>();
    for (const event of plan.events) {
      const entry = byRound.get(event.round) ?? { buy: -1, sell: -1, batch: event.batch };
      if (event.side === 'Buy') entry.buy = event.offsetMs;
      else entry.sell = event.offsetMs;
      expect(event.batch).toBe(entry.batch);
      byRound.set(event.round, entry);
    }
    for (const entry of byRound.values()) {
      expect(entry.sell).toBe(entry.buy);
      expect(entry.batch).toBeGreaterThanOrEqual(0);
    }
    // One wallet per bundle, so every round is its own batch.
    expect(plan.batches).toBe(plan.rounds.length);
  });

  it('ignores the wave control but still needs a wave value', () => {
    const tight = planVolumeSession({ ...base, mode: 'Bundle' }, rich, seed);
    const big = planVolumeSession({ ...base, mode: 'Bundle', wave: 'big-waves' }, rich, seed);
    expect(big.events.map((e) => e.offsetMs)).toEqual(tight.events.map((e) => e.offsetMs));
  });

  it('rejects a wave intensity in bundle mode', () => {
    expect(() =>
      planVolumeSession(
        { ...base, mode: 'Bundle', waveIntensityTenths: 5 },
        rich,
        seed,
      ),
    ).toThrow(VolumePlanError);
  });

  it('keeps organic mode unchanged when mode is omitted', () => {
    const legacy = planVolumeSession(base, rich, seed);
    const explicit = planVolumeSession({ ...base, mode: 'Organic' }, rich, seed);
    expect(explicit.events).toEqual(legacy.events);
    expect(legacy.terms.mode).toBeUndefined();
  });
});

describe('volume fee target', () => {
  it('splits the tip budget across trades and charges it to every wallet', () => {
    const plan = planVolumeSession(
      { ...base, feeTargetLamports: '1000000' },
      rich,
      seed,
    );
    const trades = BigInt(plan.events.length);
    expect(plan.estimate.tipPerTradeLamports).toBe((1_000_000n / trades).toString());
    expect(plan.estimate.feeTargetLamports).toBe('1000000');
    const plain = planVolumeSession(base, rich, seed);
    expect(BigInt(plan.estimate.requiredPerWalletLamports)).toBeGreaterThan(
      BigInt(plain.estimate.requiredPerWalletLamports),
    );
  });

  it('refuses a fee target too small to reach every trade', () => {
    expect(() =>
      planVolumeSession({ ...base, feeTargetLamports: '3' }, rich, seed),
    ).toThrow(/cannot cover/);
  });

  it('leaves the estimate free of tip fields when there is no target', () => {
    const plan = planVolumeSession(base, rich, seed);
    expect(plan.estimate.tipPerTradeLamports).toBeUndefined();
    expect(plan.estimate.feeTargetLamports).toBeUndefined();
  });
});
