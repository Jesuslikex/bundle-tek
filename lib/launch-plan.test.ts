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
  const stonk = {
    ...DEFAULT_LAUNCH_PLAN,
    launchpad: 'StonkFun',
    mode: 'Block-0' as const,
  };

  it('rejects a supply buy above the venue ceiling and accepts the boundary', () => {
    expect(() =>
      validateLaunchPlan({ ...stonk, developerBuy: 40, holdersBuy: 40 }),
    ).toThrow(/cannot exceed 79%/);
    expect(
      validateLaunchPlan({ ...stonk, developerBuy: 40, holdersBuy: 39 })
        .holdersBuy,
    ).toBe(39);
  });

  it('binds on the venue ceiling before the universal 100% ceiling', () => {
    // 85 is under 100 but over StonkFun's 79, and under PumpFun's 99.
    expect(() =>
      validateLaunchPlan({ ...stonk, developerBuy: 5, holdersBuy: 80 }),
    ).toThrow(/79%/);
    expect(
      validateLaunchPlan({
        ...DEFAULT_LAUNCH_PLAN,
        developerBuy: 5,
        holdersBuy: 80,
      }).holdersBuy,
    ).toBe(80);
  });

  it('counts the developer buy toward the ceiling', () => {
    // 70 holders + 10 dev is 80, one over the ceiling.
    expect(() =>
      validateLaunchPlan({ ...stonk, developerBuy: 10, holdersBuy: 70 }),
    ).toThrow(/79%/);
    expect(
      validateLaunchPlan({ ...stonk, developerBuy: 10, holdersBuy: 69 })
        .holdersBuy,
    ).toBe(69);
  });

  it('does not apply the supply ceiling outside supply mode', () => {
    // Stagger mode buys in quote units, so no supply percentage is asserted.
    expect(
      validateLaunchPlan({
        ...stonk,
        mode: 'Stagger',
        developerBuy: 40,
        holdersBuy: 50,
      }).holdersBuy,
    ).toBe(50);
  });

  it('leaves an uncaptured venue on the universal ceiling only', () => {
    // Robinhood venues are absent from the captured Solana-only table, so no
    // per-venue ceiling exists and only the universal 100% rule applies.
    const uncaptured = {
      ...DEFAULT_LAUNCH_PLAN,
      chain: 'Robinhood' as const,
      launchpad: 'flap.sh',
      currency: 'ETH',
    };
    expect(
      validateLaunchPlan({ ...uncaptured, developerBuy: 60, holdersBuy: 39 })
        .holdersBuy,
    ).toBe(39);
    expect(() =>
      validateLaunchPlan({ ...uncaptured, developerBuy: 60, holdersBuy: 50 }),
    ).toThrow(/Combined allocation/);
  });
});
