import { describe, expect, it } from 'vitest';
import {
  CEX_FUNDING_PROVIDER,
  cexSelectionLabel,
  cexSelectionReady,
  reconcileCexSelection,
  selectableCexSources,
  toggleAllCexSources,
  toggleCexSource,
  type CexFundingSource,
} from './cex-funding-sources';

const source = (
  id: string,
  available = true,
  provider = CEX_FUNDING_PROVIDER,
): CexFundingSource => ({ id, name: id.toUpperCase(), available, provider });

const CATALOG: CexFundingSource[] = [
  source('binance'),
  source('coinbase'),
  // Unavailable on this chain.
  source('kraken', false),
  // Available but served by another provider.
  source('okx', true, 'other'),
];

describe('cex funding sources', () => {
  it('offers only available sources from the expected provider', () => {
    expect(selectableCexSources(CATALOG).map((s) => s.id)).toEqual([
      'binance',
      'coinbase',
    ]);
  });

  it('keeps catalog order whatever order ids were clicked', () => {
    expect(reconcileCexSelection(['coinbase', 'binance'], CATALOG)).toEqual([
      'binance',
      'coinbase',
    ]);
  });

  it('drops ids the catalog no longer offers', () => {
    expect(
      reconcileCexSelection(['binance', 'kraken', 'gone'], CATALOG),
    ).toEqual(['binance']);
  });

  it('toggles one source on and off', () => {
    const on = toggleCexSource([], 'binance', CATALOG);
    expect(on).toEqual(['binance']);
    expect(toggleCexSource(on, 'binance', CATALOG)).toEqual([]);
  });

  it('ignores an unselectable source', () => {
    expect(toggleCexSource([], 'kraken', CATALOG)).toEqual([]);
    expect(toggleCexSource([], 'okx', CATALOG)).toEqual([]);
  });

  it('selects all offered sources, then clears when all are on', () => {
    expect(toggleAllCexSources([], CATALOG)).toEqual(['binance', 'coinbase']);
    expect(toggleAllCexSources(['binance', 'coinbase'], CATALOG)).toEqual([]);
  });

  it('selects all when only some are on', () => {
    expect(toggleAllCexSources(['binance'], CATALOG)).toEqual([
      'binance',
      'coinbase',
    ]);
  });

  it('counts against the offered total, not the whole catalog', () => {
    expect(
      cexSelectionLabel(['binance'], selectableCexSources(CATALOG).length),
    ).toBe('1/2');
  });

  it('is ready only with at least one still-offered selection', () => {
    expect(cexSelectionReady([], CATALOG)).toBe(false);
    expect(cexSelectionReady(['binance'], CATALOG)).toBe(true);
    // Selected but no longer offered is not ready.
    expect(cexSelectionReady(['kraken'], CATALOG)).toBe(false);
    // No catalog at all is not ready.
    expect(cexSelectionReady(['binance'], [])).toBe(false);
  });

  it('copes with an empty catalog', () => {
    expect(selectableCexSources([])).toEqual([]);
    expect(toggleAllCexSources([], [])).toEqual([]);
    expect(cexSelectionLabel([], 0)).toBe('0/0');
  });
});
