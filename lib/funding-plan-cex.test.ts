import { describe, expect, it } from 'vitest';
import { parseCexSources } from './funding-plan';
import { CEX_FUNDING_FALLBACK_SOURCES } from './cex-funding-catalog';

describe('parseCexSources', () => {
  it('is optional', () => {
    expect(parseCexSources(undefined, 'CEX')).toEqual([]);
    expect(parseCexSources(null, 'CEX')).toEqual([]);
  });

  it('keeps known ids in order', () => {
    expect(parseCexSources(['kucoin', 'binance'], 'CEX')).toEqual([
      'kucoin',
      'binance',
    ]);
  });

  it('accepts every captured id', () => {
    const ids = CEX_FUNDING_FALLBACK_SOURCES.map((s) => s.id);
    expect(parseCexSources(ids, 'CEX')).toEqual(ids);
  });

  it('rejects a non-array', () => {
    expect(() => parseCexSources('binance', 'CEX')).toThrow(/Invalid CEX/);
    expect(() => parseCexSources({}, 'CEX')).toThrow(/Invalid CEX/);
  });

  it('rejects unknown ids rather than dropping them', () => {
    expect(() => parseCexSources(['binance', 'mexc'], 'CEX')).toThrow(
      /Unknown CEX/,
    );
  });

  it('rejects duplicates', () => {
    expect(() => parseCexSources(['binance', 'binance'], 'CEX')).toThrow(
      /unique/,
    );
  });

  it('rejects more ids than the catalog holds', () => {
    const many = [
      ...CEX_FUNDING_FALLBACK_SOURCES.map((s) => s.id),
      ...CEX_FUNDING_FALLBACK_SOURCES.map((s) => s.id),
    ];
    expect(() => parseCexSources(many, 'CEX')).toThrow(/Too many/);
  });

  it('drops ids for a non-CEX source', () => {
    expect(parseCexSources(['binance'], 'Wallet')).toEqual([]);
    expect(parseCexSources(['binance'], 'Manual')).toEqual([]);
  });
});
