import { describe, expect, it } from 'vitest';
import {
  modeAfterVenueChange,
  validateLaunchMethod,
  venueLaunchMethods,
} from './launch-methods';
import {
  CURRENT_VENUES_BY_CHAIN,
  DEFAULT_LAUNCH_PLAN,
  deriveIllustrativeLaunchEstimate,
  validateLaunchPlan,
} from './launch-plan';

describe('captured venue launch methods', () => {
  it('distinguishes sequenced and quick profiles, preserving stagger and manual choices', () => {
    expect(venueLaunchMethods('Solana', 'PumpFun').methods).toEqual([
      'Block-0',
      'Stagger',
      'Manual',
    ]);
    expect(venueLaunchMethods('Base', 'Clanker')).toEqual({
      methods: ['Quick', 'Stagger', 'Manual'],
      initialBuyDelayMs: 11000,
      captured: true,
    });
    expect(
      venueLaunchMethods('Robinhood', 'pons.family').methods,
    ).not.toContain('Quick');
    expect(venueLaunchMethods('Arc', 'Foci').methods).not.toContain('Block-0');
    expect(venueLaunchMethods('BNB', 'FourMeme').methods).toContain('Block-0');
    expect(venueLaunchMethods('Robinhood', 'Uniswap V4')).toEqual({
      methods: ['Manual'],
      initialBuyDelayMs: null,
      captured: false,
    });
    expect(
      Object.entries(CURRENT_VENUES_BY_CHAIN).flatMap(([chain, venues]) =>
        venues.filter((venue) => venueLaunchMethods(chain, venue).captured),
      ),
    ).toHaveLength(36);
  });
  it('rejects unsupported and legacy modes for new plans while preserving structural reads', () => {
    expect(() =>
      validateLaunchMethod({ ...DEFAULT_LAUNCH_PLAN, mode: 'Quick' }),
    ).toThrow('does not support');
    expect(() =>
      validateLaunchMethod({ ...DEFAULT_LAUNCH_PLAN, mode: 'Organic' }),
    ).toThrow('Organic');
    expect(
      validateLaunchPlan({ ...DEFAULT_LAUNCH_PLAN, mode: 'Organic' }).mode,
    ).toBe('Organic');
    expect(() =>
      validateLaunchMethod({
        ...DEFAULT_LAUNCH_PLAN,
        chain: 'Base',
        launchpad: 'Clanker',
      }),
    ).toThrow('Sequenced');
    expect(() =>
      validateLaunchMethod({
        ...DEFAULT_LAUNCH_PLAN,
        chain: 'Robinhood',
        launchpad: 'Uniswap V4',
        mode: 'Manual',
      }),
    ).not.toThrow();
  });
  it('changes incompatible modes only on explicit venue changes', () => {
    expect(
      modeAfterVenueChange(DEFAULT_LAUNCH_PLAN, {
        chain: 'Base',
        launchpad: 'Clanker',
      }),
    ).toBe('Quick');
    expect(
      modeAfterVenueChange(
        { ...DEFAULT_LAUNCH_PLAN, mode: 'Stagger' },
        { chain: 'Arc', launchpad: 'Foci' },
      ),
    ).toBe('Stagger');
    expect(
      modeAfterVenueChange({ ...DEFAULT_LAUNCH_PLAN, mode: 'Organic' }, {}),
    ).toBe('Organic');
    expect(
      modeAfterVenueChange(DEFAULT_LAUNCH_PLAN, {
        chain: 'Robinhood',
        launchpad: 'Uniswap V4',
      }),
    ).toBe('Manual');
    expect(
      modeAfterVenueChange(DEFAULT_LAUNCH_PLAN, {
        chain: 'Base',
        launchpad: 'Clanker',
        mode: 'Manual',
      }),
    ).toBe('Manual');
  });
  it('does not reuse an unrelated illustrative cost model for quick or stagger methods', () => {
    for (const mode of ['Quick', 'Stagger'] as const)
      expect(
        deriveIllustrativeLaunchEstimate({ ...DEFAULT_LAUNCH_PLAN, mode })
          .scenarioTotal,
      ).toBe('—');
  });
});
