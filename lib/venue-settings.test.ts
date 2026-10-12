import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VENUE_SETTINGS,
  updatePumpfun,
  validateVenueSettings,
  percentToBasisPoints,
  parsePumpCreatorFee,
  pumpCreatorFeeEligible,
} from './venue-settings';
import {
  DEFAULT_LAUNCH_PLAN,
  validateLaunchPlan,
  deriveIllustrativeLaunchEstimate,
  CURRENT_VENUES_BY_CHAIN,
} from './launch-plan';
import { validateProjectDocument } from './workspace-project';
import { validateFunding } from './funding-plan';
const first = 'So11111111111111111111111111111111111111112';
const second = '11111111111111111111111111111111';
describe('REA-informed launch configuration', () => {
  it('clears incompatible PumpFun settings in both toggle directions', () => {
    const enabled = {
      ...DEFAULT_VENUE_SETTINGS.pumpfun,
      offchainCreation: true,
      feeSharing: true,
      feeShares: [{ address: first, shareBps: 10000 }],
    };
    const holder = updatePumpfun(enabled, { holderRewards: true });
    expect(holder).toEqual({
      holderRewards: true,
      offchainCreation: false,
      feeSharing: false,
      feeShares: [],
    });
    expect(
      updatePumpfun(holder, { offchainCreation: true }).holderRewards,
    ).toBe(false);
    expect(updatePumpfun(holder, { feeSharing: true }).holderRewards).toBe(
      false,
    );
    expect(updatePumpfun(enabled, { feeSharing: false }).feeShares).toEqual([]);
  });
  it('rejects conflicting, incomplete, duplicate or mis-scoped shares', () => {
    expect(percentToBasisPoints('1.13')).toBe(113);
    expect(Number.isInteger(percentToBasisPoints('0.015'))).toBe(false);
    const settings = {
      ...DEFAULT_VENUE_SETTINGS,
      pumpfun: {
        ...DEFAULT_VENUE_SETTINGS.pumpfun,
        feeSharing: true,
        feeShares: [
          { address: first, shareBps: 6000 },
          { address: second, shareBps: 4000 },
        ],
      },
    };
    expect(
      validateVenueSettings(settings, 'Solana', 'PumpFun').pumpfun.feeShares,
    ).toHaveLength(2);
    expect(() =>
      validateVenueSettings(
        { ...settings, pumpfun: { ...settings.pumpfun, holderRewards: true } },
        'Solana',
        'PumpFun',
      ),
    ).toThrow('cannot be combined');
    expect(() =>
      validateVenueSettings(
        {
          ...settings,
          pumpfun: {
            ...settings.pumpfun,
            feeShares: [{ address: first, shareBps: 6000 }],
          },
        },
        'Solana',
        'PumpFun',
      ),
    ).toThrow('100%');
    expect(() =>
      validateVenueSettings(
        {
          ...settings,
          pumpfun: {
            ...settings.pumpfun,
            feeShares: [
              { address: first, shareBps: 6000 },
              { address: first, shareBps: 4000 },
            ],
          },
        },
        'Solana',
        'PumpFun',
      ),
    ).toThrow('unique');
    expect(() => validateVenueSettings(settings, 'Arc', 'Argus')).toThrow(
      'require',
    );
  });
  it('preserves legacy documents and persists typed configuration', () => {
    expect(
      validateProjectDocument({ plan: DEFAULT_LAUNCH_PLAN }).options.settings,
    ).toEqual(DEFAULT_VENUE_SETTINGS);
    const settings = {
      ...DEFAULT_VENUE_SETTINGS,
      pumpfun: { ...DEFAULT_VENUE_SETTINGS.pumpfun, holderRewards: true },
    };
    const saved = validateProjectDocument({
      plan: DEFAULT_LAUNCH_PLAN,
      options: { settings },
    });
    expect(validateProjectDocument(JSON.parse(JSON.stringify(saved)))).toEqual(
      saved,
    );
    expect(() =>
      validateProjectDocument({
        plan: DEFAULT_LAUNCH_PLAN,
        options: {
          settings: {
            ...settings,
            pumpfun: { ...settings.pumpfun, offchainCreation: true },
          },
        },
      }),
    ).toThrow('cannot be combined');
  });
  it('validates observed Flap tax bounds and zero-tax exclusion', () => {
    expect(
      validateVenueSettings(DEFAULT_VENUE_SETTINGS, 'BNB', 'Flap').flap,
    ).toEqual({ buyTaxPercent: 1, sellTaxPercent: 1 });
    expect(() =>
      validateVenueSettings(
        {
          ...DEFAULT_VENUE_SETTINGS,
          flap: { buyTaxPercent: 0, sellTaxPercent: 0 },
        },
        'BNB',
        'Flap',
      ),
    ).toThrow('both be zero');
    expect(() =>
      validateVenueSettings(
        {
          ...DEFAULT_VENUE_SETTINGS,
          flap: { buyTaxPercent: 10.01, sellTaxPercent: 1 },
        },
        'Robinhood',
        'flap.sh',
      ),
    ).toThrow('0 to 10');
  });
  it('validates every current Arc venue without inventing an estimate', () => {
    for (const launchpad of CURRENT_VENUES_BY_CHAIN.Arc) {
      const plan = validateLaunchPlan({
        ...DEFAULT_LAUNCH_PLAN,
        chain: 'Arc',
        launchpad,
        currency: 'USDC',
      });
      expect(deriveIllustrativeLaunchEstimate(plan).scenarioTotal).toBe('—');
      expect(plan.simulationSafety.executionEnabled).toBe(false);
    }
  });
  it('uses Arc native USDC precision rather than Solana SPL USDC precision', () => {
    const input = {
      name: 'Arc draft',
      chain: 'Arc',
      currency: 'USDC',
      source: 'Manual',
      sourceLabel: '',
      funderAddress: '',
      startAt: new Date().toISOString(),
      delaySeconds: 1,
      recipients: [
        {
          address: '0x0000000000000000000000000000000000000001',
          amount: '0.123456789012345678',
        },
      ],
    };
    expect(validateFunding(input).total).toBe('0.123456789012345678');
    expect(() =>
      validateFunding({
        ...input,
        chain: 'Solana',
        recipients: [{ address: first, amount: '0.123456789' }],
      }),
    ).toThrow('6 decimal');
  });
});

describe('PumpFun custom creator fee', () => {
  const address = 'iNTCy1qTsUEZQe3DSocLz1ZXXai34Gdw8THQh5rxFaF';
  it('validates basis-point boundaries and quote eligibility while retaining the default', () => {
    expect(parsePumpCreatorFee(undefined)).toBeUndefined();
    for (const value of ['0.01', '1.25', '3'])
      expect(parsePumpCreatorFee(value)).toBe(value);
    for (const value of ['', '0', '3.01', '1.001', '1e0', -1, Infinity])
      expect(() => parsePumpCreatorFee(value)).toThrow();
    const plan = {
      ...DEFAULT_LAUNCH_PLAN,
      currency: 'INTC',
      quoteAddress: address,
    };
    expect(pumpCreatorFeeEligible(plan)).toBe(true);
    expect(pumpCreatorFeeEligible(DEFAULT_LAUNCH_PLAN)).toBe(false);
    const settings = {
      ...DEFAULT_VENUE_SETTINGS,
      pumpfun: { ...DEFAULT_VENUE_SETTINGS.pumpfun, creatorFeePercent: '1.25' },
    };
    expect(
      validateProjectDocument({ plan, options: { settings } }).options.settings
        .pumpfun.creatorFeePercent,
    ).toBe('1.25');
    expect(() =>
      validateProjectDocument({
        plan: DEFAULT_LAUNCH_PLAN,
        options: { settings },
      }),
    ).toThrow('quote');
    expect(() =>
      validateVenueSettings(settings, 'Solana', 'Bags', address),
    ).toThrow('quote');
  });
});
