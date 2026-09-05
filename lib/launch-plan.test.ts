import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAUNCH_PLAN,
  deriveIllustrativeLaunchEstimate,
  launchModeLabel,
  validateLaunchPlan,
} from '@/lib/launch-plan';

describe('validateLaunchPlan', () => {
  it('accepts the complete default plan', () => {
    expect(validateLaunchPlan(DEFAULT_LAUNCH_PLAN)).toEqual(DEFAULT_LAUNCH_PLAN);
  });

  it('rejects mismatched venues and non-finite values', () => {
    expect(() => validateLaunchPlan({ ...DEFAULT_LAUNCH_PLAN, chain: 'Base' })).toThrow(/Launchpad/);
    expect(() => validateLaunchPlan({ ...DEFAULT_LAUNCH_PLAN, developerBuy: Number.NaN })).toThrow(/finite/);
  });

  it('rejects allocations above total supply', () => {
    expect(() => validateLaunchPlan({ ...DEFAULT_LAUNCH_PLAN, developerBuy: 60, holdersBuy: 50 }))
      .toThrow(/Combined allocation/);
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
    expect(Number(estimate.scenarioTotal)).toBeGreaterThan(Number(estimate.supplyCost));
    expect(estimate.allocation).toBe(25);
  });
});


describe("simulation safety policy", () => {
  it("accepts the immutable safe defaults", () => {
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

  it("rejects attempts to enable execution or permit deceptive activity", () => {
    expect(() => validateLaunchPlan({
      ...DEFAULT_LAUNCH_PLAN,
      simulationSafety: { ...DEFAULT_LAUNCH_PLAN.simulationSafety, executionEnabled: true },
    })).toThrow(/Execution must remain disabled/);
    expect(() => validateLaunchPlan({
      ...DEFAULT_LAUNCH_PLAN,
      simulationSafety: { ...DEFAULT_LAUNCH_PLAN.simulationSafety, artificialVolumeProhibited: false },
    })).toThrow(/Artificial volume must remain prohibited/);
    expect(() => validateLaunchPlan({
      ...DEFAULT_LAUNCH_PLAN,
      simulationSafety: { ...DEFAULT_LAUNCH_PLAN.simulationSafety, holderFarmingProhibited: false },
    })).toThrow(/Holder farming must remain prohibited/);
  });

  it("rejects unsafe or non-finite limits", () => {
    expect(() => validateLaunchPlan({
      ...DEFAULT_LAUNCH_PLAN,
      simulationSafety: { ...DEFAULT_LAUNCH_PLAN.simulationSafety, stopLossPercent: 101 },
    })).toThrow(/Stop loss/);
    expect(() => validateLaunchPlan({
      ...DEFAULT_LAUNCH_PLAN,
      simulationSafety: { ...DEFAULT_LAUNCH_PLAN.simulationSafety, maxScenarioExposure: Number.NaN },
    })).toThrow(/finite/);
  });
});
