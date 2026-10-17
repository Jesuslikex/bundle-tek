import { describe, expect, it } from 'vitest';
import { formatReturn, pnlCard } from './pnl-card';
import type { ImportedPerformance } from './imported-performance-format';

const base: ImportedPerformance = {
  method: 'recorded-fifo',
  receiptCount: 3,
  buyCount: 2,
  sellCount: 1,
  wallets: [],
  matchedSoldRaw: '100',
  unknownBasisSoldRaw: '0',
  unresolvedSoldRaw: '0',
  realizedCostLamports: '2000000000',
  attributedNetProceedsLamports: '3000000000',
  attributedResultLamports: '1000000000',
  realizedResultLamports: '1000000000',
  openCostLamports: '0',
  recordedOpenRaw: '0',
};

describe('pnlCard', () => {
  it('computes return on realized cost', () => {
    const card = pnlCard(base, 'TEST')!;
    expect(card.returnBasisPoints).toBe(5000);
    expect(card.positive).toBe(true);
    expect(formatReturn(card.returnBasisPoints)).toBe('+50.00%');
  });
  it('marks losses', () => {
    const card = pnlCard(
      { ...base, realizedResultLamports: '-500000000' },
      'TEST',
    )!;
    expect(card.positive).toBe(false);
    expect(formatReturn(card.returnBasisPoints)).toBe('-25.00%');
  });
  it('withholds a card when the estimate is incomplete or has no sells', () => {
    expect(pnlCard({ ...base, realizedResultLamports: null }, 'T')).toBeNull();
    expect(pnlCard({ ...base, sellCount: 0, buyCount: 3 }, 'T')).toBeNull();
  });
  it('has no return without realized cost', () => {
    expect(
      pnlCard({ ...base, realizedCostLamports: '0' }, 'T')!.returnBasisPoints,
    ).toBeNull();
  });
});
