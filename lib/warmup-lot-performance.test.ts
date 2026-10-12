import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import {
  warmupLotPerformance,
  type PerformanceBuy,
  type PerformanceSell,
} from './warmup-lot-performance';
const doc = (n: number) => ({
  signature: bs58.encode(new Uint8Array(64).fill(n)),
  wallet: 'wallet',
  mint: 'mint',
  decimals: 6,
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  slot: n,
  preparationSha256: 'a'.repeat(64),
  nativeSettlementRaw: '-100',
  networkFeeLamports: '1',
  rentChangeRaw: '20',
});
const buy = (remainingRaw = '3'): PerformanceBuy => ({
  id: 'lot',
  planRevision: 1,
  walletRevision: 1,
  cycle: 1,
  wallet: 'wallet',
  mint: 'mint',
  acquiredRaw: '3',
  remainingRaw,
  decimals: 6,
  verified: 1,
  commitment: 'finalized',
  network: 'mainnet',
  document: doc(1),
});
const sell = (units = '1', n = 2): PerformanceSell => ({
  id: `sell${n}`,
  buyId: 'lot',
  consumedRaw: units,
  verified: 1,
  commitment: 'finalized',
  network: 'mainnet',
  document: { ...doc(n), nativeSettlementRaw: '50', rentChangeRaw: '-10' },
});
describe('linked warmup performance', () => {
  it('keeps empty and unsold lots separate from realized results', () => {
    expect(warmupLotPerformance([], [], [])).toMatchObject({
      lotCount: 0,
      realizedResultLamports: '0',
    });
    expect(warmupLotPerformance([buy()], [], ['lot'])).toMatchObject({
      soldLotCount: 0,
      openCostLamports: '101',
      realizedCostLamports: '0',
      realizedResultLamports: '0',
    });
  });
  it('allocates partial buy fees without expensing rent or marking open units to market', () => {
    expect(warmupLotPerformance([buy('2')], [sell()], ['lot'])).toMatchObject({
      realizedCostLamports: '33',
      openCostLamports: '68',
      netSellProceedsLamports: '49',
      realizedResultLamports: '16',
      networkFeeLamports: '2',
      rentChangeLamports: '10',
    });
  });
  it('fully allocates rounding residue and permits net losses from sell fees', () => {
    const s = sell('2', 3);
    s.document.networkFeeLamports = '60';
    expect(
      warmupLotPerformance([buy('0')], [s, sell()], ['lot']),
    ).toMatchObject({
      realizedCostLamports: '101',
      openCostLamports: '0',
      netSellProceedsLamports: '39',
      realizedResultLamports: '-62',
      networkFeeLamports: '62',
      rentChangeLamports: '0',
    });
  });
  it('preserves uint64 units and exact costs above safe integer precision', () => {
    const b = buy('18446744073709551614');
    b.acquiredRaw = '18446744073709551615';
    b.document.nativeSettlementRaw = '-9007199254740993';
    expect(warmupLotPerformance([b], [sell()], ['lot']).openCostLamports).toBe(
      '9007199254740994',
    );
  });
  it('validates excluded history and rejects unknown or duplicate scope IDs', () => {
    expect(warmupLotPerformance([buy()], [], []).lotCount).toBe(0);
    expect(() => warmupLotPerformance([buy()], [], ['missing'])).toThrow();
    expect(() => warmupLotPerformance([buy()], [], ['lot', 'lot'])).toThrow();
    expect(() => warmupLotPerformance([buy('1')], [], [])).toThrow();
  });
  it('rejects duplicate signatures, mismatched linked receipts and incomplete economics', () => {
    const mutations: Array<(s: PerformanceSell) => void> = [
      (s) => {
        s.document.signature = doc(1).signature;
      },
      (s) => {
        s.document.wallet = 'other';
      },
      (s) => {
        s.document.mint = 'other';
      },
      (s) => {
        s.document.decimals = 9;
      },
      (s) => {
        s.document.slot = 1;
      },
      (s) => {
        s.document.tokenProgram = 'unknown';
      },
      (s) => {
        s.verified = 0;
      },
      (s) => {
        s.document.networkFeeLamports = '1.1';
      },
      (s) => {
        s.buyId = 'missing';
      },
      (s) => {
        s.consumedRaw = '4';
      },
      (s) => {
        s.document.nativeSettlementRaw = '-50';
      },
    ];
    for (const mutate of mutations) {
      const s = sell();
      mutate(s);
      expect(() => warmupLotPerformance([buy('2')], [s], ['lot'])).toThrow();
    }
    expect(() =>
      warmupLotPerformance([buy('1')], [sell(), sell()], ['lot']),
    ).toThrow();
  });
});
