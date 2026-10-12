import { describe, it, expect } from 'vitest';
import {
  quoteCatalog,
  quoteAsset,
  validateQuoteSelection,
} from './quote-catalog';
import {
  DEFAULT_LAUNCH_PLAN,
  CURRENT_VENUES_BY_CHAIN,
  validateLaunchPlan,
} from './launch-plan';

describe('captured quote identity', () => {
  it('reports the absent profile and unresolved metadata without inventing tokens', () => {
    const gaps: string[] = [];
    for (const [chain, venues] of Object.entries(CURRENT_VENUES_BY_CHAIN))
      for (const venue of venues)
        if (!quoteCatalog(chain, venue).captured)
          gaps.push(chain + '/' + venue);
    expect(gaps).toEqual(['Robinhood/Uniswap V4']);
    expect(quoteCatalog('Robinhood', 'stonks.fun').unresolved).toHaveLength(1);
    expect(
      quoteCatalog('Robinhood', 'stonks.fun').assets.map((a) => a.symbol),
    ).toEqual(['ETH']);
  });
  it('requires an address when Arc USDC identifies both native and wrapped assets', () => {
    const plan = {
      ...DEFAULT_LAUNCH_PLAN,
      chain: 'Arc' as const,
      launchpad: 'Argus',
      currency: 'USDC',
    };
    expect(() => validateQuoteSelection(plan)).toThrow(/multiple/);
    for (const asset of quoteCatalog('Arc', 'Argus').assets) {
      expect(asset.decimals).toBe(18);
      expect(() =>
        validateQuoteSelection({ ...plan, quoteAddress: asset.address }),
      ).not.toThrow();
    }
  });
  it('distinguishes duplicate Solana symbols and preserves the chosen mint', () => {
    const assets = quoteCatalog('Solana', 'StonkFun').assets.filter(
      (a) => a.symbol === 'OPENAI',
    );
    expect(assets.length).toBeGreaterThan(1);
    const plan = {
      ...DEFAULT_LAUNCH_PLAN,
      launchpad: 'StonkFun',
      currency: 'OPENAI',
    };
    expect(() => validateQuoteSelection(plan)).toThrow(/multiple/);
    for (const asset of assets)
      expect(
        validateLaunchPlan({ ...plan, quoteAddress: asset.address })
          .quoteAddress,
      ).toBe(asset.address);
    expect(
      quoteAsset('Solana', 'StonkFun', assets[0].address.toLowerCase()),
    ).toBeUndefined();
  });
  it('rejects a supported token on the wrong venue or under the wrong symbol', () => {
    const usdc = quoteCatalog('Solana', 'PumpFun').assets.find(
      (a) => a.symbol === 'USDC',
    )!;
    expect(() =>
      validateQuoteSelection({
        ...DEFAULT_LAUNCH_PLAN,
        launchpad: 'Printr',
        currency: 'USDC',
      }),
    ).toThrow(/not supported/);
    expect(() =>
      validateLaunchPlan({
        ...DEFAULT_LAUNCH_PLAN,
        quoteAddress: usdc.address,
      }),
    ).toThrow(/does not match/);
  });
  it('keeps old symbol-only documents structurally readable while strict new saves reject unsupported choices', () => {
    const legacy = validateLaunchPlan({
      ...DEFAULT_LAUNCH_PLAN,
      launchpad: 'Printr',
      currency: 'USDC',
    });
    expect(legacy.currency).toBe('USDC');
    expect(() => validateQuoteSelection(legacy)).toThrow(/not supported/);
    expect(() => validateQuoteSelection(DEFAULT_LAUNCH_PLAN)).not.toThrow();
  });
  it('canonicalizes EVM address case and derives decimals from catalog metadata', () => {
    const asset = quoteCatalog('BNB', 'Flap').assets.find(
      (a) => a.symbol === 'USDT',
    )!;
    const plan = validateLaunchPlan({
      ...DEFAULT_LAUNCH_PLAN,
      chain: 'BNB',
      launchpad: 'Flap',
      currency: 'USDT',
      quoteAddress: asset.address.toUpperCase(),
    });
    expect(plan.quoteAddress).toBe(asset.address);
    expect(quoteAsset('BNB', 'Flap', plan.quoteAddress!)?.decimals).toBe(18);
  });
});
