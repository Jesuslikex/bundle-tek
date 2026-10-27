import { describe, expect, it } from 'vitest';
import {
  CLEANUP_MAX_DELAY_MS,
  CLEANUP_MIN_DELAY_MS,
  cleanupDelayMs,
  cleanupDelayParts,
  cleanupPayload,
  cleanupPlan,
  cleanupPercent,
  cleanupRoundDelay,
  cleanupRounds,
  type CleanupPlan,
} from './wallet-cleanup-plan';

const A = 'So11111111111111111111111111111111111111112';
const B = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const plan = (over: Partial<CleanupPlan> = {}): CleanupPlan => ({
  inputWalletPubkeys: [A],
  outputWalletPubkeys: [B],
  minDelayMs: 16_000,
  maxDelayMs: 16_000,
  doubleBuyPct: 0,
  fakeTipPct: 0,
  ...over,
});

describe('cleanupPayload', () => {
  it('emits Proxima key order and casing', () => {
    expect(Object.keys(cleanupPayload(plan()))).toEqual([
      'input_wallet_pubkeys',
      'output_wallet_pubkeys',
      'min_delay_ms',
      'max_delay_ms',
      'double_buy_pct',
      'fake_tip_pct',
    ]);
  });

  it('copies the wallet lists', () => {
    const input = [A];
    const payload = cleanupPayload(plan({ inputWalletPubkeys: input }));
    input.push(B);
    expect(payload.input_wallet_pubkeys).toEqual([A]);
  });

  it('rejects a min delay under half a second', () => {
    expect(() => cleanupPayload(plan({ minDelayMs: 499 }))).toThrow(
      'Min delay must be at least 0.5 seconds',
    );
  });

  it('rejects a max delay over five minutes', () => {
    expect(() =>
      cleanupPayload(plan({ maxDelayMs: CLEANUP_MAX_DELAY_MS + 1 })),
    ).toThrow('Max delay cannot exceed 300 seconds');
  });

  it('rejects an inverted range', () => {
    expect(() =>
      cleanupPayload(plan({ minDelayMs: 5_000, maxDelayMs: 1_000 })),
    ).toThrow('Min delay cannot be greater than max delay');
  });

  it('rejects an empty seller list before the buyer list', () => {
    expect(() =>
      cleanupPayload(plan({ inputWalletPubkeys: [], outputWalletPubkeys: [] })),
    ).toThrow('Please select at least one input wallet (seller)');
  });

  it('rejects an empty buyer list', () => {
    expect(() => cleanupPayload(plan({ outputWalletPubkeys: [] }))).toThrow(
      'Please select at least one output wallet (buyer)',
    );
  });

  it('rejects a double buy percentage over 100', () => {
    expect(() => cleanupPayload(plan({ doubleBuyPct: 101 }))).toThrow(
      'Double buy percentage must be between 0 and 100',
    );
  });

  it('rejects a negative double buy percentage', () => {
    expect(() => cleanupPayload(plan({ doubleBuyPct: -1 }))).toThrow(
      'Double buy percentage must be between 0 and 100',
    );
  });

  it('rejects an alternative routing percentage over 100', () => {
    expect(() => cleanupPayload(plan({ fakeTipPct: 101 }))).toThrow(
      'Fake tip percentage must be between 0 and 100',
    );
  });

  it('floors percentages like Proxima', () => {
    expect(cleanupPayload(plan({ doubleBuyPct: 12.9 })).double_buy_pct).toBe(12);
  });

  it('accepts the exact minimum delay', () => {
    expect(
      cleanupPayload(plan({ minDelayMs: CLEANUP_MIN_DELAY_MS })).min_delay_ms,
    ).toBe(500);
  });

  it('accepts the exact maximum delay', () => {
    expect(
      cleanupPayload(plan({ minDelayMs: 1_000, maxDelayMs: CLEANUP_MAX_DELAY_MS }))
        .max_delay_ms,
    ).toBe(300_000);
  });
});

describe('cleanupPercent', () => {
  it('treats an empty field as zero', () => {
    expect(cleanupPercent('')).toBe(0);
    expect(cleanupPercent(undefined)).toBe(0);
    expect(cleanupPercent('7')).toBe(7);
  });
});

describe('cleanupDelayMs', () => {
  it('reads MIN:SEC', () => {
    expect(cleanupDelayMs(1, 30)).toBe(90_000);
    expect(cleanupDelayMs('', '16')).toBe(16_000);
    expect(cleanupDelayMs(0, 0)).toBe(0);
  });
});

describe('cleanupDelayParts', () => {
  it('splits milliseconds back into MIN:SEC', () => {
    expect(cleanupDelayParts(90_000)).toEqual({ minutes: 1, seconds: 30 });
    expect(cleanupDelayParts(16_000)).toEqual({ minutes: 0, seconds: 16 });
  });
});

describe('cleanupRounds', () => {
  it('pairs each seller with a buyer round-robin', () => {
    expect(cleanupRounds(['s1', 's2', 's3'], ['b1', 'b2'])).toEqual([
      { round: 1, seller: 's1', buyer: 'b1' },
      { round: 2, seller: 's2', buyer: 'b2' },
      { round: 3, seller: 's3', buyer: 'b1' },
    ]);
  });

  it('is empty without buyers', () => {
    expect(cleanupRounds(['s1'], [])).toEqual([]);
  });
});

describe('cleanupRoundDelay', () => {
  it('uses the min delay when fixed', () => {
    expect(cleanupRoundDelay('Fixed', 1_000, 9_000, () => 0.5)).toBe(1_000);
  });

  it('walks the range when random', () => {
    expect(cleanupRoundDelay('Random', 1_000, 9_000, () => 0)).toBe(1_000);
    expect(cleanupRoundDelay('Random', 1_000, 9_000, () => 1)).toBe(9_000);
    expect(cleanupRoundDelay('Random', 1_000, 9_000, () => 0.5)).toBe(5_000);
  });

  it('falls back to min when the range is flat', () => {
    expect(cleanupRoundDelay('Random', 4_000, 4_000, () => 0.9)).toBe(4_000);
  });
});

describe('cleanupPlan', () => {
  it('round-trips a payload', () => {
    const payload = cleanupPayload(plan({ doubleBuyPct: 20, fakeTipPct: 5 }));
    expect(cleanupPlan(payload)).toEqual(
      plan({ doubleBuyPct: 20, fakeTipPct: 5 }),
    );
  });
});
