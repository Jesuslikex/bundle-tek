import { expect, it } from 'vitest';
import bs58 from 'bs58';
import { reviewWalletWarmupSession } from './wallet-warmup-session-review';
import { buildWarmupPlan, type WarmupInput } from './wallet-warmup';
import { warmupCycleProgress } from './warmup-cycle-progress';
import {
  warmupLotPerformance,
  type PerformanceBuy,
  type PerformanceSell,
} from './warmup-lot-performance';
import type { SavedWarmup } from './wallet-warmup-storage';
const now = Date.parse('2026-10-20T12:00:00Z');
const wallets = [
  bs58.encode(new Uint8Array(32).fill(1)),
  bs58.encode(new Uint8Array(32).fill(2)),
];
const mints = [
  bs58.encode(new Uint8Array(32).fill(3)),
  bs58.encode(new Uint8Array(32).fill(4)),
];
function plan(patch: Partial<WarmupInput> = {}, clock = now): SavedWarmup {
  const document = {
    chain: 'Solana',
    addresses: wallets,
    tokens: mints,
    amount: '0.001',
    feeReserve: '0.01',
    cycles: 2,
    intervalSeconds: 10,
    startAt: new Date(clock).toISOString(),
    ...patch,
  };
  const built = buildWarmupPlan(document, clock);
  return {
    id: 'synthetic',
    revision: 2,
    archived: false,
    updatedAt: new Date(clock).toISOString(),
    document: {
      ...document,
      name: 'Synthetic',
      walletRevisions: document.addresses.map((address) => ({
        address,
        revision: 2,
      })),
      totalBudget: built.totalBudget,
    },
  };
}
function buy(
  n: number,
  p: SavedWarmup,
  cycle = 1,
  remaining = '10',
): PerformanceBuy {
  const wallet = p.document.addresses[0],
    mint = p.document.tokens[(cycle - 1) % p.document.tokens.length];
  return {
    id: `lot-${n}`,
    planRevision: p.revision,
    walletRevision: 2,
    cycle,
    wallet,
    mint,
    acquiredRaw: '10',
    remainingRaw: remaining,
    decimals: 6,
    verified: 1,
    commitment: 'finalized',
    network: 'mainnet',
    document: {
      signature: bs58.encode(new Uint8Array(64).fill(n)),
      wallet,
      mint,
      decimals: 6,
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      slot: n,
      preparationSha256: 'a'.repeat(64),
      nativeSettlementRaw: '-1000000',
      networkFeeLamports: '5000',
      rentChangeRaw: '0',
    },
  };
}
function sell(b: PerformanceBuy, n: number, units = '10'): PerformanceSell {
  return {
    id: `sell-${n}`,
    buyId: b.id,
    consumedRaw: units,
    verified: 1,
    commitment: 'finalized',
    network: 'mainnet',
    document: {
      ...b.document,
      signature: bs58.encode(new Uint8Array(64).fill(n)),
      slot: n,
      nativeSettlementRaw: '900000',
      networkFeeLamports: '5000',
    },
  };
}
function evidence(
  p: SavedWarmup,
  buys: PerformanceBuy[] = [],
  sells: PerformanceSell[] = [],
) {
  const progress = warmupCycleProgress(p, buys, sells, [], false);
  return {
    progress,
    performance: warmupLotPerformance(
      buys,
      sells,
      progress.steps.flatMap((step) => step.buyIds),
    ),
  };
}
function review(
  p = plan(),
  buys: PerformanceBuy[] = [],
  sells: PerformanceSell[] = [],
  clock = now,
) {
  const e = evidence(p, buys, sells);
  return reviewWalletWarmupSession(p, e.progress, e.performance, clock);
}
it('builds a finite exact current-revision action list and per-wallet budget without granting execution', () => {
  const result = review();
  expect(result.actions).toHaveLength(8);
  expect(
    result.actions
      .filter((action) => action.side === 'Buy')
      .map((action) => action.inputLamports),
  ).toEqual(['1000000', '1000000', '1000000', '1000000']);
  for (const action of result.actions.filter(
    (action) => action.side === 'Sell',
  )) {
    expect(action.source.kind).toBe('session-buy');
    if (action.source.kind === 'session-buy') {
      const sourceId = action.source.actionId;
      expect(
        result.actions.some(
          (buy) =>
            buy.id === sourceId &&
            buy.side === 'Buy' &&
            buy.wallet === action.wallet &&
            buy.cycle === action.cycle,
        ),
      ).toBe(true);
    }
  }
  expect(
    result.wallets.map((wallet) => wallet.maximumNativeSpendLamports),
  ).toEqual(['12000000', '12000000']);
  expect(result.totalMaximumNativeSpendLamports).toBe('24000000');
  expect(result).toMatchObject({
    executionAllowed: false,
    signingAllowed: false,
    automaticExecutionAllowed: false,
    status: 'Review required',
  });
});
it('uses the saved range draws without rerolling or sharing another wallet’s amounts', () => {
  const p = plan({
    amountMax: '0.002',
    amounts: [
      ['0.001', '0.002'],
      ['0.0015', '0.0012'],
    ],
  });
  const result = review(p);
  expect(
    result.actions
      .filter((action) => action.side === 'Buy')
      .map((action) => action.inputLamports),
  ).toEqual(['1000000', '1500000', '2000000', '1200000']);
  expect(result.totalMaximumNativeSpendLamports).toBe('25700000');
  expect(review(p).contextKey).toBe(result.contextKey);
});
it('skips finalized completed loops instead of planning duplicate buys', () => {
  const p = plan(),
    b = buy(1, p, 1, '0');
  const result = review(p, [b], [sell(b, 10)]);
  expect(result.actions).toHaveLength(6);
  expect(
    result.actions.some(
      (action) => action.wallet === wallets[0] && action.cycle === 1,
    ),
  ).toBe(false);
  expect(result.completedRecordedLoops).toBe(1);
  expect(result.wallets[0].maximumNativeSpendLamports).toBe('10990000');
});
it('plans only exact remaining saved lots for a partially recorded cycle, never a replacement buy', () => {
  const p = plan(),
    a = buy(1, p, 1, '3'),
    b = buy(2, p, 1, '7');
  a.document.nativeSettlementRaw = '-500000';
  b.document.nativeSettlementRaw = '-500000';
  const result = review(p, [a, b], [sell(a, 10, '7'), sell(b, 11, '3')]);
  const actions = result.actions.filter(
    (action) => action.wallet === wallets[0] && action.cycle === 1,
  );
  expect(actions).toHaveLength(2);
  expect(actions.map((action) => action.side)).toEqual(['Sell', 'Sell']);
  expect(
    actions.map((action) => (action.side === 'Sell' ? action.source : null)),
  ).toEqual([
    {
      kind: 'saved-buy',
      buyReceiptId: 'lot-1',
      remainingRaw: '3',
      decimals: 6,
    },
    {
      kind: 'saved-buy',
      buyReceiptId: 'lot-2',
      remainingRaw: '7',
      decimals: 6,
    },
  ]);
});

it('carries recorded fees and retained rent forward without crediting rent refunds as extra budget', () => {
  const p = plan(),
    b = buy(1, p);
  b.document.rentChangeRaw = '2000000';
  const first = review(p, [b]);
  expect(first.wallets[0]).toMatchObject({
    recordedBuySpendLamports: '1000000',
    recordedNetworkFeesLamports: '5000',
    recordedRentChangeLamports: '2000000',
    remainingFeeReserveLamports: '7995000',
    maximumNativeSpendLamports: '8995000',
  });
  b.document.rentChangeRaw = '-2000000';
  expect(review(p, [b]).wallets[0].remainingFeeReserveLamports).toBe('9995000');
});
it.each([
  'duplicate-buy-spend',
  'fee-reserve',
  'exhausted-fee-reserve',
] as const)(
  'refuses a new spending plan beyond prior saved budgets: %s',
  (reason) => {
    const p = plan(),
      a = buy(1, p),
      b = buy(2, p);
    if (reason === 'fee-reserve') a.document.networkFeeLamports = '10000001';
    if (reason === 'exhausted-fee-reserve')
      a.document.networkFeeLamports = '10000000';
    expect(() =>
      review(p, reason === 'duplicate-buy-spend' ? [a, b] : [a]),
    ).toThrow(/budget|reserve/);
  },
);
it('rebuilds past schedules from the reviewed start without catch-up bursts or mutating the saved plan', () => {
  const p = plan({}, now - 86400000),
    before = structuredClone(p);
  const result = review(p);
  expect(result.originalStartAt).toBe(before.document.startAt);
  expect(result.effectiveStartAt).toBe(new Date(now).toISOString());
  expect(
    result.actions.every((action) => Date.parse(action.scheduledAt) >= now),
  ).toBe(true);
  expect(
    result.actions
      .filter((action) => action.wallet === wallets[0] && action.side === 'Buy')
      .map((action) => Date.parse(action.scheduledAt)),
  ).toEqual([now, now + 10000]);
  expect(p).toEqual(before);
});
it('retains a future saved start and changes exact review context when wallet revisions change', () => {
  const p = plan({ startAt: new Date(now + 60000).toISOString() }),
    prior = review(p);
  expect(prior.effectiveStartAt).toBe(p.document.startAt);
  p.document.walletRevisions[0].revision++;
  const next = review(p);
  expect(next.contextKey).not.toBe(prior.contextKey);
  expect(next.wallets[0].walletRevision).toBe(3);
});
it('returns completed history with no new action, fee reserve or authority', () => {
  const p = plan({ addresses: [wallets[0]], tokens: [mints[0]], cycles: 1 }),
    b = buy(1, p, 1, '0');
  const result = review(p, [b], [sell(b, 10)]);
  expect(result).toMatchObject({
    status: 'Recorded loops complete',
    actions: [],
    totalMaximumNativeSpendLamports: '0',
    executionAllowed: false,
    signingAllowed: false,
    automaticExecutionAllowed: false,
  });
});
it.each([
  'approval',
  'earlier',
  'excluded',
  'budget',
  'wallets',
  'archived',
  'chain',
  'scope',
] as const)('refuses unsettled or changed session context: %s', (kind) => {
  const p = plan(),
    e = evidence(p);
  switch (kind) {
    case 'approval':
      e.progress.activeApprovals = 1;
      break;
    case 'earlier':
      e.progress.includeEarlier = true;
      break;
    case 'excluded':
      e.progress.excludedBuys = 1;
      break;
    case 'budget':
      p.document.totalBudget = '999';
      break;
    case 'wallets':
      p.document.walletRevisions.pop();
      break;
    case 'archived':
      p.archived = true;
      break;
    case 'chain':
      p.document.chain = 'Base';
      break;
    case 'scope':
      e.progress.revision++;
      break;
  }
  expect(() =>
    reviewWalletWarmupSession(p, e.progress, e.performance, now),
  ).toThrow();
});
it('owns returned nested values and cannot modify the next review by mutating a prior result', () => {
  const p = plan(),
    result = review(p),
    original = structuredClone(p);
  result.actions[0].wallet = 'changed';
  result.wallets[0].maximumNativeSpendLamports = '999';
  expect(p).toEqual(original);
  expect(review(p).actions[0].wallet).toBe(wallets[0]);
  expect(review(p).wallets[0].maximumNativeSpendLamports).toBe('12000000');
});
