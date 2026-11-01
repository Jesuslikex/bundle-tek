import { validateSequencedSupply } from './launch-supply';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAUNCH_PLAN,
  deriveIllustrativeLaunchEstimate,
  launchModeLabel,
  validateLaunchPlan,
} from '@/lib/launch-plan';

describe('validateLaunchPlan', () => {
  it('accepts the complete default plan', () => {
    expect(validateLaunchPlan(DEFAULT_LAUNCH_PLAN)).toEqual(
      DEFAULT_LAUNCH_PLAN,
    );
  });

  it('rejects mismatched venues and non-finite values', () => {
    expect(() =>
      validateLaunchPlan({ ...DEFAULT_LAUNCH_PLAN, chain: 'Base' }),
    ).toThrow(/Launchpad/);
    expect(() =>
      validateLaunchPlan({ ...DEFAULT_LAUNCH_PLAN, developerBuy: Number.NaN }),
    ).toThrow(/finite/);
  });

  it('rejects allocations above total supply', () => {
    expect(() =>
      validateLaunchPlan({
        ...DEFAULT_LAUNCH_PLAN,
        developerBuy: 60,
        holdersBuy: 50,
      }),
    ).toThrow(/Combined allocation/);
  });
});

describe('public launch-mode labels', () => {
  it('does not advertise unsupported Block-0 guarantees', () => {
    expect(launchModeLabel('Block-0')).toBe('Sequenced');
    expect(launchModeLabel('Organic')).toBe('Organic');
  });
});

describe('deriveIllustrativeLaunchEstimate', () => {
  it('derives values solely from a validated plan', () => {
    const plan = validateLaunchPlan(DEFAULT_LAUNCH_PLAN);
    const estimate = deriveIllustrativeLaunchEstimate(plan);
    expect(Number(estimate.scenarioTotal)).toBeGreaterThan(
      Number(estimate.supplyCost),
    );
    expect(estimate.allocation).toBe(25);
  });
});

describe('simulation safety policy', () => {
  it('accepts the immutable safe defaults', () => {
    const plan = validateLaunchPlan(DEFAULT_LAUNCH_PLAN);
    expect(plan.simulationSafety).toEqual({
      maxIllustrativeTurnover: 250,
      maxScenarioExposure: 50,
      minimumInventoryReservePercent: 20,
      stopLossPercent: 8,
      maximumDurationMinutes: 60,
      executionEnabled: false,
      artificialVolumeProhibited: true,
      holderFarmingProhibited: true,
    });
  });

  it('rejects attempts to enable execution or permit deceptive activity', () => {
    expect(() =>
      validateLaunchPlan({
        ...DEFAULT_LAUNCH_PLAN,
        simulationSafety: {
          ...DEFAULT_LAUNCH_PLAN.simulationSafety,
          executionEnabled: true,
        },
      }),
    ).toThrow(/Execution must remain disabled/);
    expect(() =>
      validateLaunchPlan({
        ...DEFAULT_LAUNCH_PLAN,
        simulationSafety: {
          ...DEFAULT_LAUNCH_PLAN.simulationSafety,
          artificialVolumeProhibited: false,
        },
      }),
    ).toThrow(/Artificial volume must remain prohibited/);
    expect(() =>
      validateLaunchPlan({
        ...DEFAULT_LAUNCH_PLAN,
        simulationSafety: {
          ...DEFAULT_LAUNCH_PLAN.simulationSafety,
          holderFarmingProhibited: false,
        },
      }),
    ).toThrow(/Holder farming must remain prohibited/);
  });

  it('rejects unsafe or non-finite limits', () => {
    expect(() =>
      validateLaunchPlan({
        ...DEFAULT_LAUNCH_PLAN,
        simulationSafety: {
          ...DEFAULT_LAUNCH_PLAN.simulationSafety,
          stopLossPercent: 101,
        },
      }),
    ).toThrow(/Stop loss/);
    expect(() =>
      validateLaunchPlan({
        ...DEFAULT_LAUNCH_PLAN,
        simulationSafety: {
          ...DEFAULT_LAUNCH_PLAN.simulationSafety,
          maxScenarioExposure: Number.NaN,
        },
      }),
    ).toThrow(/finite/);
  });
});

describe('captured venue supply-buy ceiling', () => {
  // StonkFun's captured max_total_buy_percentage is 79; PumpFun's is 99.
  // Save-time rule: parse, then the same supply check both save APIs run.
  const save = (value: unknown) => {
    const plan = validateLaunchPlan(value);
    validateSequencedSupply(plan);
    return plan;
  };
  const stonk = {
    ...DEFAULT_LAUNCH_PLAN,
    launchpad: 'StonkFun',
    mode: 'Block-0' as const,
  };

  it('rejects a supply buy above the venue ceiling and accepts the boundary', () => {
    expect(() => save({ ...stonk, developerBuy: 40, holdersBuy: 40 })).toThrow(
      /cannot exceed 79%/,
    );
    expect(
      save({ ...stonk, developerBuy: 40, holdersBuy: 39 }).holdersBuy,
    ).toBe(39);
  });

  it('binds on the venue ceiling before the universal 100% ceiling', () => {
    // 85 is under 100 but over StonkFun's 79, and under PumpFun's 99.
    expect(() => save({ ...stonk, developerBuy: 5, holdersBuy: 80 })).toThrow(
      /79%/,
    );
    expect(
      save({
        ...DEFAULT_LAUNCH_PLAN,
        developerBuy: 5,
        holdersBuy: 80,
      }).holdersBuy,
    ).toBe(80);
  });

  it('counts the developer buy toward the ceiling', () => {
    // 70 holders + 10 dev is 80, one over the ceiling.
    expect(() => save({ ...stonk, developerBuy: 10, holdersBuy: 70 })).toThrow(
      /79%/,
    );
    expect(
      save({ ...stonk, developerBuy: 10, holdersBuy: 69 }).holdersBuy,
    ).toBe(69);
  });

  it('does not apply the supply ceiling outside supply mode', () => {
    // Stagger mode buys in quote units, so no supply percentage is asserted.
    expect(
      save({
        ...stonk,
        mode: 'Stagger',
        developerBuy: 40,
        holdersBuy: 50,
      }).holdersBuy,
    ).toBe(50);
  });

  it('leaves an uncaptured venue on the universal ceiling only', () => {
    // Robinhood Uniswap V4 is the one offered venue the capture never
    // describes, so no per-venue ceiling exists and only 100% applies.
    const uncaptured = {
      ...DEFAULT_LAUNCH_PLAN,
      chain: 'Robinhood' as const,
      launchpad: 'Uniswap V4',
      currency: 'ETH',
    };
    expect(
      save({ ...uncaptured, developerBuy: 60, holdersBuy: 39 }).holdersBuy,
    ).toBe(39);
    expect(() =>
      save({ ...uncaptured, developerBuy: 60, holdersBuy: 50 }),
    ).toThrow(/Combined allocation/);
  });

  it('still parses a stored plan above the ceiling so saved projects load', () => {
    // Reads go through validateLaunchPlan alone; a historical 80% StonkFun
    // plan must not break the project library.
    expect(
      validateLaunchPlan({ ...stonk, developerBuy: 40, holdersBuy: 40 })
        .holdersBuy,
    ).toBe(40);
  });
});

describe('captured MEV estimate inputs', () => {
  it('defaults the slider to the captured midpoint', () => {
    expect(DEFAULT_LAUNCH_PLAN.mevSlider).toBe(1);
    expect(validateLaunchPlan(DEFAULT_LAUNCH_PLAN).mevSlider).toBe(1);
  });

  it('accepts the captured slider bounds inclusive', () => {
    expect(
      validateLaunchPlan({ ...DEFAULT_LAUNCH_PLAN, mevSlider: 0.4 }).mevSlider,
    ).toBe(0.4);
    expect(
      validateLaunchPlan({ ...DEFAULT_LAUNCH_PLAN, mevSlider: 1.6 }).mevSlider,
    ).toBe(1.6);
  });

  it('rejects a slider outside the captured bounds', () => {
    for (const mevSlider of [0.39, 1.61, 0, 2, Number.NaN])
      expect(() =>
        validateLaunchPlan({ ...DEFAULT_LAUNCH_PLAN, mevSlider }),
      ).toThrow(/MEV slider/);
  });

  it('keeps the estimate inputs optional', () => {
    const plan = validateLaunchPlan({
      ...DEFAULT_LAUNCH_PLAN,
      supplyCostBps: undefined,
      estimatedDurationMs: undefined,
    });
    expect(plan.supplyCostBps).toBeUndefined();
    expect(plan.estimatedDurationMs).toBeUndefined();
  });

  it('accepts whole supply cost basis points up to 10000', () => {
    expect(
      validateLaunchPlan({ ...DEFAULT_LAUNCH_PLAN, supplyCostBps: 0 })
        .supplyCostBps,
    ).toBe(0);
    expect(
      validateLaunchPlan({ ...DEFAULT_LAUNCH_PLAN, supplyCostBps: 10000 })
        .supplyCostBps,
    ).toBe(10000);
  });

  it('rejects fractional or oversized supply cost', () => {
    for (const supplyCostBps of [1.5, -1, 10001])
      expect(() =>
        validateLaunchPlan({ ...DEFAULT_LAUNCH_PLAN, supplyCostBps }),
      ).toThrow(/Supply cost/);
  });

  it('bounds the estimated duration in whole milliseconds', () => {
    expect(
      validateLaunchPlan({ ...DEFAULT_LAUNCH_PLAN, estimatedDurationMs: 0 })
        .estimatedDurationMs,
    ).toBe(0);
    expect(() =>
      validateLaunchPlan({
        ...DEFAULT_LAUNCH_PLAN,
        estimatedDurationMs: 86_400_001,
      }),
    ).toThrow(/Estimated duration/);
    expect(() =>
      validateLaunchPlan({
        ...DEFAULT_LAUNCH_PLAN,
        estimatedDurationMs: 1.5,
      }),
    ).toThrow(/Estimated duration/);
  });
});
