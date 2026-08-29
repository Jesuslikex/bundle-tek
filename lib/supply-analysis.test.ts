import { describe, expect, it } from 'vitest';
import { formatRawAmount, percentOfSupply } from '@/lib/supply-analysis';

describe('formatRawAmount', () => {
  it('formats raw token units without losing bigint precision', () => {
    expect(formatRawAmount(1234567890123456789n, 9)).toBe('1234567890.123456');
  });

  it('formats zero-decimal supplies', () => {
    expect(formatRawAmount(42n, 0)).toBe('42');
  });
});

describe('percentOfSupply', () => {
  it('returns a four-decimal percentage without converting bigint inputs first', () => {
    expect(percentOfSupply(1n, 3n)).toBe(33.3333);
  });

  it('returns zero for an empty supply', () => {
    expect(percentOfSupply(10n, 0n)).toBe(0);
  });
});
