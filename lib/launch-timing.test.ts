import { describe, expect, it } from 'vitest';
import { DEFAULT_LAUNCH_PLAN, validateLaunchPlan } from './launch-plan';
import {
  launchTimingBounds,
  parseLaunchTiming,
  timingAfterPlanChange,
  validateLaunchTiming,
} from './launch-timing';
describe('launch pacing', () => {
  it('retains legacy absence and exact integer milliseconds', () => {
    expect(validateLaunchPlan(DEFAULT_LAUNCH_PLAN)).toEqual(
      DEFAULT_LAUNCH_PLAN,
    );
    expect(
      validateLaunchPlan({
        ...DEFAULT_LAUNCH_PLAN,
        timing: { buyDelayMs: 1000, initialBuyDelayMs: 0 },
      }).timing,
    ).toEqual({ buyDelayMs: 1000, initialBuyDelayMs: 0 });
    for (const v of [-1, 1.5, 60001, '1000', NaN, Infinity])
      expect(() =>
        parseLaunchTiming({ buyDelayMs: v, initialBuyDelayMs: 0 }),
      ).toThrow();
    expect(() =>
      parseLaunchTiming({ buyDelayMs: 0, initialBuyDelayMs: 86400001 }),
    ).toThrow();
    expect(() => parseLaunchTiming([])).toThrow();
  });
  it('enforces sequenced/stagger bounds and zero pacing for quick/manual', () => {
    expect(launchTimingBounds(DEFAULT_LAUNCH_PLAN).maxMs).toBe(1000);
    expect(
      launchTimingBounds({ ...DEFAULT_LAUNCH_PLAN, mode: 'Stagger' }).maxMs,
    ).toBe(60000);
    expect(() =>
      validateLaunchTiming({
        ...DEFAULT_LAUNCH_PLAN,
        timing: { buyDelayMs: 1001, initialBuyDelayMs: 0 },
      }),
    ).toThrow('0 to 1000');
    expect(() =>
      validateLaunchTiming({
        ...DEFAULT_LAUNCH_PLAN,
        mode: 'Stagger',
        timing: { buyDelayMs: 60000, initialBuyDelayMs: 0 },
      }),
    ).not.toThrow();
    for (const mode of ['Quick', 'Manual'] as const)
      expect(() =>
        validateLaunchTiming({
          ...DEFAULT_LAUNCH_PLAN,
          mode,
          timing: { buyDelayMs: 1, initialBuyDelayMs: 0 },
        }),
      ).toThrow('0 to 0');
  });
  it('admits optional initial delay only for captured enabled automatic profiles', () => {
    const plan = {
      ...DEFAULT_LAUNCH_PLAN,
      chain: 'Base' as const,
      launchpad: 'Clanker',
      mode: 'Quick' as const,
      timing: { buyDelayMs: 0, initialBuyDelayMs: 12345 },
    };
    expect(() => validateLaunchTiming(plan)).not.toThrow();
    expect(launchTimingBounds(plan).initialSuggestedMs).toBe(11000);
    expect(() => validateLaunchTiming({ ...plan, mode: 'Manual' })).toThrow(
      'unavailable',
    );
    expect(() =>
      validateLaunchTiming({ ...DEFAULT_LAUNCH_PLAN, timing: plan.timing }),
    ).toThrow('unavailable');
  });
  it('clears unavailable timings on explicit switches but keeps out-of-range pacing for correction', () => {
    const plan = {
      ...DEFAULT_LAUNCH_PLAN,
      mode: 'Stagger' as const,
      timing: { buyDelayMs: 60000, initialBuyDelayMs: 0 },
    };
    expect(
      timingAfterPlanChange(plan, { mode: 'Block-0' }, 'Block-0')?.buyDelayMs,
    ).toBe(60000);
    expect(
      timingAfterPlanChange(plan, { mode: 'Quick' }, 'Quick')?.buyDelayMs,
    ).toBe(0);
    expect(timingAfterPlanChange(plan, {}, plan.mode)).toEqual(plan.timing);
    expect(
      timingAfterPlanChange(
        { ...plan, timing: { buyDelayMs: 0, initialBuyDelayMs: 11000 } },
        { mode: 'Manual' },
        'Manual',
      ),
    ).toEqual({ buyDelayMs: 0, initialBuyDelayMs: 0 });
  });
});
