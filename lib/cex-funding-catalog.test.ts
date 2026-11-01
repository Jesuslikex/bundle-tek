import { describe, expect, it } from 'vitest';
import {
  CEX_FUNDING_FALLBACK_SOURCES,
  cexIdsFromLabel,
  cexSourcesLabel,
} from './cex-funding-catalog';
import {
  CEX_FUNDING_PROVIDER,
  selectableCexSources,
} from './cex-funding-sources';

describe('captured cex funding fallback catalog', () => {
  it('matches the list the client hard-codes, all available and husher-served', () => {
    expect(CEX_FUNDING_FALLBACK_SOURCES.map((s) => s.id)).toEqual([
      'binance',
      'gate',
      'kucoin',
    ]);
    expect(
      CEX_FUNDING_FALLBACK_SOURCES.every(
        (s) => s.available && s.provider === CEX_FUNDING_PROVIDER,
      ),
    ).toBe(true);
    // So the picker offers all of them.
    expect(selectableCexSources(CEX_FUNDING_FALLBACK_SOURCES)).toHaveLength(3);
  });

  it('is frozen so a caller cannot mutate the shared catalog', () => {
    expect(Object.isFrozen(CEX_FUNDING_FALLBACK_SOURCES)).toBe(true);
  });

  it('labels the chosen sources in catalog order', () => {
    expect(cexSourcesLabel(['kucoin', 'binance'])).toBe('Binance, KuCoin');
    expect(cexSourcesLabel([])).toBe('');
  });

  it('ignores unknown ids when labelling', () => {
    expect(cexSourcesLabel(['binance', 'mexc'])).toBe('Binance');
  });

  it('round-trips a label back to ids', () => {
    const label = cexSourcesLabel(['binance', 'gate']);
    expect(label).toBe('Binance, Gate');
    expect(cexIdsFromLabel(label)).toEqual(['binance', 'gate']);
  });

  it('restores from ids written literally, case-insensitively', () => {
    expect(cexIdsFromLabel('binance, KUCOIN')).toEqual(['binance', 'kucoin']);
  });

  it('treats free text as no selection', () => {
    expect(cexIdsFromLabel('Treasury')).toEqual([]);
    expect(cexIdsFromLabel('')).toEqual([]);
  });
});
