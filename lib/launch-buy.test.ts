import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAUNCH_PLAN,
  deriveIllustrativeLaunchEstimate,
  validateLaunchPlan,
} from './launch-plan';
import {
  holdersBuyUnit,
  holdersQuoteAfterPlanChange,
  parseHoldersQuoteAmount,
  validateHoldersQuoteAmount,
} from './launch-buy';
import { validateSequencedSupply } from './launch-supply';

describe('quote-denominated holders buy inputs', () => {
  it('preserves precise decimal amounts and rejects lossy or unsupported notation', () => {
    const quick = {
      ...DEFAULT_LAUNCH_PLAN,
      mode: 'Stagger' as const,
      holdersBuyQuote: '0.020000001000000000',
    };
    const parsed = validateLaunchPlan(quick);
    expect(parsed.holdersBuyQuote).toBe('0.020000001');
    expect(() => validateHoldersQuoteAmount(parsed)).not.toThrow();
    expect(
      parseHoldersQuoteAmount('12345678901234567890.123456789012345678'),
    ).toBe('12345678901234567890.123456789012345678');
    for (const value of [
      0.1,
      '1e-9',
      '-1',
      'Infinity',
      'NaN',
      ' 1',
      '01',
      '1.',
      '0.0000000000000000001',
      '1'.repeat(31),
    ])
      expect(() => parseHoldersQuoteAmount(value)).toThrow();
    expect(parseHoldersQuoteAmount('0.000')).toBe('0');
    expect(parseHoldersQuoteAmount(undefined)).toBeUndefined();
  });
  it('enforces selected token precision without conflating quote and supply units', () => {
    const plan = {
      ...DEFAULT_LAUNCH_PLAN,
      mode: 'Stagger' as const,
      currency: 'USDC',
      holdersBuyQuote: '0.123456',
    };
    expect(() => validateHoldersQuoteAmount(plan)).not.toThrow();
    expect(() =>
      validateHoldersQuoteAmount({ ...plan, holdersBuyQuote: '0.1234567' }),
    ).toThrow('6 decimal');
    expect(() =>
      validateHoldersQuoteAmount({
        ...plan,
        currency: 'SOL',
        holdersBuyQuote: '0.0000000001',
      }),
    ).toThrow('9 decimal');
    expect(() =>
      validateHoldersQuoteAmount({
        ...plan,
        chain: 'Arc',
        launchpad: 'Argus',
        currency: 'USDC',
        quoteAddress: '0x0000000000000000000000000000000000000000',
        holdersBuyQuote: '0.000000000000000001',
      }),
    ).not.toThrow();
    expect(() =>
      validateHoldersQuoteAmount({
        ...plan,
        chain: 'Robinhood',
        launchpad: 'Uniswap V4',
        currency: 'ETH',
      }),
    ).toThrow('captured');
    for (const mode of ['Quick', 'Stagger', 'Manual'] as const)
      expect(holdersBuyUnit({ ...plan, mode })).toBe('quote');
    expect(holdersBuyUnit({ ...plan, mode: 'Block-0' })).toBe('supply');
    expect(holdersBuyUnit({ ...plan, mode: 'Block-0', scheduled: true })).toBe(
      'quote',
    );
    expect(holdersBuyUnit({ ...plan, launchpad: 'Stoxes' })).toBe('supply');
    const native = validateLaunchPlan({
      ...DEFAULT_LAUNCH_PLAN,
      mode: 'Stagger',
      developerBuy: 79,
      holdersBuy: 99,
      holdersBuyQuote: '120.000000001',
    });
    expect(native.holdersBuyQuote).toBe('120.000000001');
    expect(() => validateSequencedSupply(native)).not.toThrow();
    expect(() =>
      validateSequencedSupply({ ...native, developerBuy: 80 }),
    ).toThrow('79%');
    expect(deriveIllustrativeLaunchEstimate(native)).toMatchObject({
      allocation: null,
      scenarioTotal: '—',
    });
  });
  it('retains dormant percentages and exact quote amounts across methods but clears quote-denomination changes', () => {
    const current = { ...DEFAULT_LAUNCH_PLAN, holdersBuyQuote: '0.05' };
    expect(holdersQuoteAfterPlanChange(current, { mode: 'Stagger' })).toBe(
      '0.05',
    );
    expect(holdersQuoteAfterPlanChange(current, { scheduled: true })).toBe(
      '0.05',
    );
    expect(
      holdersQuoteAfterPlanChange(current, { currency: 'USDC' }),
    ).toBeUndefined();
    expect(
      holdersQuoteAfterPlanChange(current, { launchpad: 'Bags' }),
    ).toBeUndefined();
    expect(
      holdersQuoteAfterPlanChange(current, { quoteAddress: 'different-token' }),
    ).toBeUndefined();
    expect(
      holdersQuoteAfterPlanChange(current, {
        currency: 'USDC',
        holdersBuyQuote: '0.1',
      }),
    ).toBe('0.1');
    const historical = validateLaunchPlan({
      ...DEFAULT_LAUNCH_PLAN,
      mode: 'Stagger',
    });
    expect(historical.holdersBuy).toBe(20);
    expect(historical.holdersBuyQuote).toBeUndefined();
  });
});
