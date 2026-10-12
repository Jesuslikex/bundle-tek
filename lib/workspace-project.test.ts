import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAUNCH_PLAN,
  currenciesForVenue,
  deriveIllustrativeLaunchEstimate,
  validateLaunchPlan,
  VENUES_BY_CHAIN,
  CURRENT_VENUES_BY_CHAIN,
} from './launch-plan';
import {
  DEFAULT_VENUE_OPTIONS,
  EMPTY_IDENTITY,
  projectIdValid,
  validateProjectDocument,
} from './workspace-project';

describe('workspace documents', () => {
  it('preserves the legacy plan with empty optional metadata', () => {
    expect(validateProjectDocument({ plan: DEFAULT_LAUNCH_PLAN })).toEqual({
      plan: DEFAULT_LAUNCH_PLAN,
      identity: EMPTY_IDENTITY,
      options: DEFAULT_VENUE_OPTIONS,
    });
  });
  it('rejects executable URLs, credential URLs, invalid supplies and tax', () => {
    for (const artworkUrl of [
      'javascript:alert(1)',
      'data:image/png,a',
      'https://user:pass@example.com/a',
    ]) {
      expect(() =>
        validateProjectDocument({
          plan: DEFAULT_LAUNCH_PLAN,
          identity: { artworkUrl },
        }),
      ).toThrow();
    }
    for (const options of [
      { totalSupply: '0' },
      { totalSupply: '1.5' },
      { creatorTax: NaN },
      { creatorTax: 11 },
      { buyback: 'yes' },
    ]) {
      expect(() =>
        validateProjectDocument({ plan: DEFAULT_LAUNCH_PLAN, options }),
      ).toThrow();
    }
    expect(projectIdValid('../anything')).toBe(false);
    expect(projectIdValid('project-1')).toBe(true);
  });
  it('accepts public metadata while stripping unknown fields', () => {
    const value = validateProjectDocument({
      plan: DEFAULT_LAUNCH_PLAN,
      identity: { website: 'https://example.com' },
      privateKey: 'not-stored',
      options: { unrelated: true },
    });
    expect(value.identity.website).toBe('https://example.com');
    expect(JSON.stringify(value)).not.toContain('not-stored');
    expect(value.options).not.toHaveProperty('unrelated');
  });
});

describe('reference venue profiles', () => {
  it('offers 37 current venues over six chains and preserves retired saved profiles', () => {
    expect(Object.keys(VENUES_BY_CHAIN)).toHaveLength(6);
    expect(Object.values(CURRENT_VENUES_BY_CHAIN).flat()).toHaveLength(37);
    expect(CURRENT_VENUES_BY_CHAIN.Robinhood).toHaveLength(15);
    expect(VENUES_BY_CHAIN.Robinhood).toContain('long.xyz');
    expect(CURRENT_VENUES_BY_CHAIN.Robinhood).not.toContain('long.xyz');
  });
  it('enforces venue-specific quote currencies without enabling execution', () => {
    const plan = {
      ...DEFAULT_LAUNCH_PLAN,
      chain: 'Robinhood',
      launchpad: 'pons.family',
      currency: 'USDG',
    };
    expect(validateLaunchPlan(plan).simulationSafety.executionEnabled).toBe(
      false,
    );
    expect(() =>
      validateLaunchPlan({ ...plan, currency: 'NONEXISTENT' }),
    ).toThrow();
    expect(
      validateLaunchPlan({ ...plan, launchpad: 'long.xyz', currency: 'AAPL' })
        .currency,
    ).toBe('AAPL');
    expect(currenciesForVenue('Robinhood', 'long.xyz')).toHaveLength(71);
    expect(
      deriveIllustrativeLaunchEstimate(validateLaunchPlan(plan)).scenarioTotal,
    ).toBe('—');
  });
  it('normalizes the previous Base quote label to ETH', () => {
    expect(
      validateLaunchPlan({
        ...DEFAULT_LAUNCH_PLAN,
        chain: 'Base',
        launchpad: 'Clanker',
        currency: 'Base',
      }).currency,
    ).toBe('ETH');
  });
});
