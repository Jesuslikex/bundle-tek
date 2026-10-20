import { expect, it } from 'vitest';
import bs58 from 'bs58';
import { walletWarmupActivity } from './wallet-warmup-activity';
import { warmupCycleProgress } from './warmup-cycle-progress';
import {
  warmupLotPerformance,
  type PerformanceBuy,
  type PerformanceSell,
} from './warmup-lot-performance';
import type { SavedWarmup } from './wallet-warmup-storage';
const plan: SavedWarmup = {
  id: 'fixture',
  revision: 2,
  archived: false,
  updatedAt: '2026-10-20T00:00:00.000Z',
  document: {
    name: 'Synthetic',
    chain: 'Solana',
    addresses: ['a', 'b'],
    walletRevisions: [
      { address: 'a', revision: 2 },
      { address: 'b', revision: 2 },
    ],
    tokens: ['mint-a', 'mint-b'],
    cycles: 2,
    amount: '0.001',
    feeReserve: '0.01',
    intervalMinutes: 1,
    startAt: '2026-10-20T00:00:00.000Z',
    totalBudget: '0.02',
  },
};
function buy(
  n: number,
  wallet = 'a',
  cycle = 1,
  remaining = '10',
): PerformanceBuy {
  return {
    id: `buy-${n}`,
    wallet,
    cycle,
    planRevision: 2,
    walletRevision: 2,
    mint: cycle === 1 ? 'mint-a' : 'mint-b',
    acquiredRaw: '10',
    remainingRaw: remaining,
    decimals: 6,
    verified: 1,
    commitment: 'finalized',
    network: 'mainnet',
    document: {
      signature: bs58.encode(new Uint8Array(64).fill(n)),
      wallet,
      mint: cycle === 1 ? 'mint-a' : 'mint-b',
      decimals: 6,
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      slot: n,
      preparationSha256: 'a'.repeat(64),
      nativeSettlementRaw: '-100',
      networkFeeLamports: '5',
      rentChangeRaw: '20',
    },
  };
}
function sell(b: PerformanceBuy, n: number, consumed = '10'): PerformanceSell {
  return {
    id: `sell-${n}`,
    buyId: b.id,
    consumedRaw: consumed,
    verified: 1,
    commitment: 'finalized',
    network: 'mainnet',
    document: {
      ...b.document,
      signature: bs58.encode(new Uint8Array(64).fill(n)),
      slot: n,
      nativeSettlementRaw: '50',
      networkFeeLamports: '7',
      rentChangeRaw: '-10',
    },
  };
}
function input(
  buys: PerformanceBuy[] = [],
  sells: PerformanceSell[] = [],
  earlier = false,
  recovery = false,
) {
  const progress = warmupCycleProgress(
    plan,
    buys,
    sells,
    recovery ? [{ id: 'pending', wallet: 'a', state: 'submitted' }] : [],
    earlier,
  );
  return {
    progress,
    performance: warmupLotPerformance(
      buys,
      sells,
      progress.steps.flatMap((step) => step.buyIds),
    ),
  };
}
it('includes every configured wallet with zero evidence without inferring activity or completion', () => {
  const { progress, performance } = input();
  const rows = walletWarmupActivity(plan, progress, performance);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    wallet: 'a',
    completedCycles: 0,
    totalCycles: 2,
    transactionCount: 0,
    volumeLamports: '0',
    state: 'No recorded trades',
  });
});
it('counts finalized transactions and exact SOL turnover across mints while excluding fees and rent', () => {
  const a = buy(1, 'a', 1, '0'),
    b = buy(2, 'a', 2, '5'),
    c = buy(3, 'b');
  const { progress, performance } = input(
    [a, b, c],
    [sell(a, 4), sell(b, 5, '5')],
  );
  const rows = walletWarmupActivity(plan, progress, performance);
  expect(rows[0]).toMatchObject({
    completedCycles: 1,
    totalCycles: 2,
    buyTransactions: 2,
    sellTransactions: 2,
    transactionCount: 4,
    buyVolumeLamports: '200',
    sellVolumeLamports: '100',
    volumeLamports: '300',
    state: 'Partially recorded',
  });
  expect(rows[1]).toMatchObject({
    completedCycles: 0,
    buyTransactions: 1,
    sellTransactions: 0,
    transactionCount: 1,
    volumeLamports: '100',
  });
});
it('counts partial sells separately without turning them into completed loops', () => {
  const a = buy(1, 'a', 1, '5');
  const { progress, performance } = input(
    [a],
    [sell(a, 2, '2'), sell(a, 3, '3')],
  );
  expect(walletWarmupActivity(plan, progress, performance)[0]).toMatchObject({
    completedCycles: 0,
    transactionCount: 3,
    sellTransactions: 2,
    volumeLamports: '200',
  });
});
it('uses explicit historical scope and never double-counts recovery once per cycle', () => {
  const a = buy(1, 'a', 1, '0');
  a.planRevision = 1;
  a.walletRevision = 1;
  const current = input([a], [sell(a, 2)]);
  expect(
    walletWarmupActivity(plan, current.progress, current.performance)[0]
      .transactionCount,
  ).toBe(0);
  const historical = input([a], [sell(a, 2)], true, true);
  expect(
    walletWarmupActivity(plan, historical.progress, historical.performance)[0],
  ).toMatchObject({
    transactionCount: 2,
    recoveryCount: 1,
    completedCycles: 0,
    state: 'Recovery required',
  });
});
it('keeps lamports beyond Number precision exact', () => {
  const a = buy(1);
  a.document.nativeSettlementRaw = '-9007199254740993';
  const { progress, performance } = input([a]);
  expect(
    walletWarmupActivity(plan, progress, performance)[0].volumeLamports,
  ).toBe('9007199254740993');
});
it.each([
  'missing-step',
  'duplicate-step',
  'other-wallet',
  'wrong-mint',
  'duplicate-lot',
  'missing-lot',
  'foreign-lot',
  'bad-volume',
  'missing-volume',
  'bad-count',
  'wrong-state',
  'wrong-remaining',
  'wrong-revision',
] as const)(
  'refuses malformed or misbound summary evidence: %s',
  (mutation) => {
    const a = buy(1),
      { progress, performance } = input([a]);
    switch (mutation) {
      case 'missing-step':
        progress.steps.pop();
        break;
      case 'duplicate-step':
        progress.steps[1] = structuredClone(progress.steps[0]);
        break;
      case 'other-wallet':
        progress.steps[0].wallet = 'outsider';
        break;
      case 'wrong-mint':
        progress.steps[0].mint = 'other';
        break;
      case 'duplicate-lot':
        performance.lots.push(structuredClone(performance.lots[0]));
        performance.lotCount++;
        break;
      case 'missing-lot':
        performance.lots = [];
        performance.lotCount = 0;
        break;
      case 'foreign-lot':
        performance.lots[0].wallet = 'other';
        break;
      case 'bad-volume':
        performance.lots[0].buyVolumeLamports = '-1';
        break;
      case 'missing-volume':
        Reflect.deleteProperty(performance.lots[0], 'buyVolumeLamports');
        break;
      case 'bad-count':
        performance.lots[0].sellCount = NaN;
        break;
      case 'wrong-state':
        progress.steps[0].state = 'Recorded lots sold';
        break;
      case 'wrong-remaining':
        progress.steps[0].remainingRaw = '0';
        break;
      case 'wrong-revision':
        progress.revision++;
        break;
    }
    expect(() => walletWarmupActivity(plan, progress, performance)).toThrow();
  },
);
