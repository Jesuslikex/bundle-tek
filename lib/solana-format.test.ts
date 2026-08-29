import { describe, expect, it } from 'vitest';
import { lamportsToSolNumber } from './solana-format';

describe('lamportsToSolNumber', () => {
  it('formats whole and fractional SOL balances', () => {
    expect(lamportsToSolNumber(1_500_000_000n)).toBe(1.5);
    expect(lamportsToSolNumber(25_000n)).toBe(0.000025);
  });

  it('formats an empty wallet as zero', () => {
    expect(lamportsToSolNumber(0n)).toBe(0);
  });
});
