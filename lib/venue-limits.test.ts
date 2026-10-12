import { describe, it, expect } from 'vitest';
import { venueLimits, validateVenuePlan } from './venue-limits';
import {
  DEFAULT_LAUNCH_PLAN,
  validateLaunchPlan,
  CURRENT_VENUES_BY_CHAIN,
} from './launch-plan';
describe('captured venue identity and recipient limits', () => {
  it('covers every current venue except the explicitly unverified Robinhood Uniswap V4 profile', () => {
    const gaps: string[] = [];
    for (const [chain, venues] of Object.entries(CURRENT_VENUES_BY_CHAIN))
      for (const venue of venues) {
        if (!venueLimits(chain, venue).verified) gaps.push(`${chain}/${venue}`);
      }
    expect(gaps).toEqual(['Robinhood/Uniswap V4']);
  });
  it('accepts the 64/16 boundaries for pons and Foci while rejecting overflow', () => {
    for (const [chain, launchpad, currency] of [
      ['Robinhood', 'pons.family', 'ETH'],
      ['Arc', 'Foci', 'USDC'],
    ] as const) {
      const plan = validateLaunchPlan({
        ...DEFAULT_LAUNCH_PLAN,
        chain,
        launchpad,
        currency,
        tokenName: 'A'.repeat(64),
        ticker: 'B'.repeat(16),
      });
      expect(() => validateVenuePlan(plan)).not.toThrow();
      expect(() =>
        validateVenuePlan({ ...plan, tokenName: 'A'.repeat(65) }),
      ).toThrow('64');
      expect(() =>
        validateVenuePlan({ ...plan, ticker: 'B'.repeat(17) }),
      ).toThrow('16');
    }
  });
  it('enforces PumpFun combined 42-character boundary independently of individual bounds', () => {
    const plan = {
      ...DEFAULT_LAUNCH_PLAN,
      tokenName: 'A'.repeat(29),
      ticker: 'B'.repeat(13),
    };
    expect(() => validateVenuePlan(plan)).not.toThrow();
    expect(() =>
      validateVenuePlan({ ...plan, tokenName: 'A'.repeat(30) }),
    ).toThrow('together');
  });
  it('applies 24/15 limits to Flap and 100-recipient caps to captured restricted venues', () => {
    const plan = {
      ...DEFAULT_LAUNCH_PLAN,
      chain: 'BNB',
      launchpad: 'Flap',
      tokenName: 'A'.repeat(24),
      ticker: 'B'.repeat(15),
    };
    expect(() => validateVenuePlan(plan)).not.toThrow();
    expect(() =>
      validateVenuePlan({ ...plan, tokenName: 'A'.repeat(25) }),
    ).toThrow('24');
    for (const [chain, launchpad] of [
      ['BNB', 'knot.fun'],
      ['Robinhood', 'hood.fun'],
      ['Robinhood', 'Flywheel'],
      ['Robinhood', 'CoinBarrel'],
    ]) {
      expect(() =>
        validateVenuePlan({
          ...DEFAULT_LAUNCH_PLAN,
          chain,
          launchpad,
          holderCount: 100,
        }),
      ).not.toThrow();
      expect(() =>
        validateVenuePlan({
          ...DEFAULT_LAUNCH_PLAN,
          chain,
          launchpad,
          holderCount: 101,
        }),
      ).toThrow('100 recipients');
    }
  });
  it('allows incomplete saved drafts but requires descriptions at the continuation step', () => {
    const plan = {
      ...DEFAULT_LAUNCH_PLAN,
      chain: 'Robinhood',
      launchpad: 'pons.family',
    };
    expect(() => validateVenuePlan(plan)).not.toThrow();
    expect(() => validateVenuePlan(plan, true)).toThrow('description');
    expect(() =>
      validateVenuePlan({ ...plan, description: 'Project description' }, true),
    ).not.toThrow();
    expect(() => validateVenuePlan(DEFAULT_LAUNCH_PLAN, true)).not.toThrow();
  });
});
