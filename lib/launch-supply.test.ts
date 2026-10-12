import { describe, expect, it } from 'vitest';
import { DEFAULT_LAUNCH_PLAN, validateLaunchPlan } from './launch-plan';
import {
  developerBuyAfterPlanChange,
  sequencedSupplyLimits,
  validateSequencedSupply,
} from './launch-supply';

describe('captured Sequenced supply buy limits', () => {
  it('accepts exact totals and rejects combined overflow and venue-specific developer overflow', () => {
    const pump = { ...DEFAULT_LAUNCH_PLAN, developerBuy: 79, holdersBuy: 20 };
    expect(() => validateSequencedSupply(pump)).not.toThrow();
    expect(() =>
      validateSequencedSupply({ ...pump, holdersBuy: 20.01 }),
    ).toThrow('99%');
    expect(() =>
      validateSequencedSupply({ ...pump, developerBuy: 80, holdersBuy: 0 }),
    ).toThrow('79%');
    const stonk = {
      ...pump,
      launchpad: 'StonkFun',
      developerBuy: 50,
      holdersBuy: 29,
    };
    expect(() => validateSequencedSupply(stonk)).not.toThrow();
    expect(() =>
      validateSequencedSupply({ ...stonk, developerBuy: 50.01, holdersBuy: 0 }),
    ).toThrow('50%');
    expect(() =>
      validateSequencedSupply({ ...stonk, holdersBuy: 29.01 }),
    ).toThrow('79%');
  });
  it('applies the captured BNB Flap exception and does not mistake native-buy modes for supply buys', () => {
    const flap = {
      ...DEFAULT_LAUNCH_PLAN,
      chain: 'Robinhood' as const,
      launchpad: 'flap.sh',
      currency: 'ETH',
      developerBuy: 79,
      holdersBuy: 1,
    };
    expect(() => validateSequencedSupply(flap)).toThrow('79%');
    expect(() =>
      validateSequencedSupply({
        ...flap,
        chain: 'BNB',
        launchpad: 'Flap',
        currency: 'BNB',
        holdersBuy: 20,
      }),
    ).not.toThrow();
    for (const mode of ['Quick', 'Stagger', 'Manual'] as const)
      expect(sequencedSupplyLimits({ ...flap, mode })).toBeNull();
    expect(sequencedSupplyLimits({ ...flap, scheduled: true })).toBeNull();
    expect(
      sequencedSupplyLimits({ ...flap, launchpad: 'Uniswap V4' }),
    ).toBeNull();
  });
  it('keeps historical amounts readable and only clears unsupported developer supply on explicit selection changes', () => {
    const old = {
      ...DEFAULT_LAUNCH_PLAN,
      launchpad: 'Anoncoin',
      developerBuy: 5,
    };
    expect(validateLaunchPlan(old).developerBuy).toBe(5);
    expect(() => validateSequencedSupply(old)).toThrow('does not support');
    expect(developerBuyAfterPlanChange(old, {}, 'Block-0')).toBe(5);
    expect(
      developerBuyAfterPlanChange(
        DEFAULT_LAUNCH_PLAN,
        { launchpad: 'Anoncoin' },
        'Block-0',
      ),
    ).toBe(0);
    expect(
      developerBuyAfterPlanChange(
        DEFAULT_LAUNCH_PLAN,
        { launchpad: 'Bags' },
        'Block-0',
      ),
    ).toBe(5);
    expect(
      developerBuyAfterPlanChange(
        { ...DEFAULT_LAUNCH_PLAN, developerBuy: 80 },
        { mode: 'Block-0' },
        'Block-0',
      ),
    ).toBe(80);
  });
});
