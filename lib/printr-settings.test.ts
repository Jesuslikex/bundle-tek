import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRINTR_SETTINGS,
  validatePrintrSettings,
} from './printr-settings';
import { DEFAULT_VENUE_SETTINGS } from './venue-settings';
import { DEFAULT_LAUNCH_PLAN } from './launch-plan';
import { validateProjectDocument } from './workspace-project';

describe('captured Printr settings', () => {
  const parse = (change: Record<string, unknown> = {}) =>
    validatePrintrSettings(
      { ...DEFAULT_PRINTR_SETTINGS, ...change },
      'Solana',
      'Printr',
    );
  it('retains captured defaults and exact optional market-cap strings', () => {
    expect(
      validatePrintrSettings(undefined, 'Solana', 'Printr'),
    ).toBeUndefined();
    expect(parse()).toEqual(DEFAULT_PRINTR_SETTINGS);
    expect(
      parse({
        initialMarketCapUsd: '5000.00',
        beforeMigrationFeePercent: '1.50',
        afterMigrationFeePercent: '1.40',
      }),
    ).toMatchObject({
      initialMarketCapUsd: '5000',
      beforeMigrationFeePercent: '1.5',
      afterMigrationFeePercent: '1.4',
    });
    expect(
      parse({ initialMarketCapUsd: '999999999999999.99' })?.initialMarketCapUsd,
    ).toBe('999999999999999.99');
  });
  it('rejects unsupported presets, profiles and fee/cap bounds', () => {
    for (const change of [
      { feeDestination: 'wallet' },
      { maxSupply: 'unlimited' },
      { initialMarketCapUsd: '4999.99' },
      { initialMarketCapUsd: 'NaN' },
      { initialMarketCapUsd: '5e3' },
      { initialMarketCapUsd: '5000.001' },
      { initialMarketCapUsd: 5000 },
      { beforeMigrationFeePercent: '0' },
      { beforeMigrationFeePercent: '1.51' },
      { afterMigrationFeePercent: '1.41' },
      { afterMigrationFeePercent: '0.001' },
    ])
      expect(() => parse(change)).toThrow();
    expect(() =>
      validatePrintrSettings(DEFAULT_PRINTR_SETTINGS, 'Solana', 'PumpFun'),
    ).toThrow('profile');
    expect(() =>
      validatePrintrSettings(DEFAULT_PRINTR_SETTINGS, 'BNB', 'Printr'),
    ).toThrow('profile');
  });
  it('roundtrips settings through the project validator without altering old drafts', () => {
    expect(
      validateProjectDocument({ plan: DEFAULT_LAUNCH_PLAN }).options.settings,
    ).toEqual(DEFAULT_VENUE_SETTINGS);
    const doc = validateProjectDocument({
      plan: { ...DEFAULT_LAUNCH_PLAN, launchpad: 'Printr' },
      options: {
        settings: {
          ...DEFAULT_VENUE_SETTINGS,
          printr: {
            ...DEFAULT_PRINTR_SETTINGS,
            feeDestination: 'buyback',
            maxSupply: '100_million',
            initialMarketCapUsd: '6500.25',
          },
        },
      },
    });
    expect(validateProjectDocument(JSON.parse(JSON.stringify(doc)))).toEqual(
      doc,
    );
    expect(() =>
      validateProjectDocument({ ...doc, plan: DEFAULT_LAUNCH_PLAN }),
    ).toThrow('profile');
  });
});
