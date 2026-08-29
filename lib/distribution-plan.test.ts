import { describe, expect, it } from 'vitest';
import { buildDistributionPlan, isSolanaAddress } from './distribution-plan';

const SYSTEM = '11111111111111111111111111111111';
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';

describe('distribution plan', () => {
  it('validates Solana addresses', () => {
    expect(isSolanaAddress(SYSTEM)).toBe(true);
    expect(isSolanaAddress('not-a-wallet')).toBe(false);
  });

  it('merges duplicates and creates deterministic batches', () => {
    const plan = buildDistributionPlan({
      manifest: `${SYSTEM}, 10, treasury\n${WRAPPED_SOL}, 20, community\n${SYSTEM}, 5, duplicate`,
      tokenSupply: 100,
      reservePercent: 20,
      batchSize: 1,
    });
    expect(plan.recipients).toHaveLength(2);
    expect(plan.recipients[0].amount).toBe(15);
    expect(plan.batches).toHaveLength(2);
    expect(plan.totalAmount).toBe(35);
    expect(plan.warnings).toHaveLength(1);
  });

  it('rejects allocations above the distributable supply', () => {
    expect(() => buildDistributionPlan({ manifest: `${SYSTEM}, 81`, tokenSupply: 100, reservePercent: 20, batchSize: 8 }))
      .toThrow('exceeds');
  });
});

