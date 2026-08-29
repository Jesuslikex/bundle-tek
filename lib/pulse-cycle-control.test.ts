import { describe, expect, it } from 'vitest';
import {
  CYCLE_RETENTION_DAYS,
  cycleRetentionCutoff,
  requireIdempotencyKey,
} from '@/lib/pulse-cycle-control';

describe('pulse cycle controls', () => {
  it('accepts a UUID idempotency key', () => {
    const request = new Request('https://bundle.test/api/pulse/cycles', {
      headers: { 'idempotency-key': '8f90e842-3137-4f33-a306-48d88059578f' },
    });
    expect(requireIdempotencyKey(request)).toBe('8f90e842-3137-4f33-a306-48d88059578f');
  });

  it('rejects missing and undersized idempotency keys', () => {
    expect(() => requireIdempotencyKey(new Request('https://bundle.test'))).toThrow(/required/);
    expect(() => requireIdempotencyKey(new Request('https://bundle.test', {
      headers: { 'idempotency-key': 'short' },
    }))).toThrow(/required/);
  });

  it('computes a deterministic retention cutoff', () => {
    const now = new Date('2026-08-29T00:00:00.000Z');
    expect(cycleRetentionCutoff(now)).toBe(
      new Date(now.getTime() - CYCLE_RETENTION_DAYS * 86_400_000).toISOString(),
    );
  });
});
