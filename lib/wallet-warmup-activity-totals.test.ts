import { expect, it } from 'vitest';
import {
  walletWarmupActivityTotals as totals,
  type WalletWarmupActivity,
} from './wallet-warmup-activity';
const row = (
  change: Partial<WalletWarmupActivity[number]> = {},
): WalletWarmupActivity[number] => ({
  wallet: 'synthetic-wallet-a',
  completedCycles: 0,
  totalCycles: 2,
  buyTransactions: 1,
  sellTransactions: 0,
  transactionCount: 1,
  buyVolumeLamports: '100',
  sellVolumeLamports: '0',
  volumeLamports: '100',
  recoveryCount: 0,
  state: 'Partially recorded',
  ...change,
});
it('aggregates receipt counts, wallet completion and turnover independently', () => {
  const complete = row({
    completedCycles: 2,
    buyTransactions: 2,
    sellTransactions: 3,
    transactionCount: 5,
    sellVolumeLamports: '90',
    volumeLamports: '190',
    state: 'Recorded loops complete',
  });
  const partial = row({ wallet: 'synthetic-wallet-b' });
  expect(totals([complete, partial])).toMatchObject({
    walletCount: 2,
    completedWallets: 1,
    completedCycles: 2,
    totalCycles: 4,
    transactionCount: 6,
    buyTransactions: 3,
    sellTransactions: 3,
    volumeLamports: '290',
    state: 'partial',
  });
});
it('never treats an empty selection or zero receipts as completion', () => {
  expect(totals([])).toMatchObject({
    state: 'empty',
    completedWallets: 0,
    transactionCount: 0,
    volumeLamports: '0',
  });
  expect(
    totals([
      row({
        buyTransactions: 0,
        transactionCount: 0,
        buyVolumeLamports: '0',
        volumeLamports: '0',
        state: 'No recorded trades',
      }),
    ]),
  ).toMatchObject({
    state: 'unrecorded',
    completedCycles: 0,
    transactionCount: 0,
  });
});
it('keeps totals beyond Number precision exact across wallets', () => {
  const a = row({
    completedCycles: 1,
    buyTransactions: 2,
    sellTransactions: 1,
    transactionCount: 3,
    buyVolumeLamports: '9007199254740993',
    sellVolumeLamports: '3',
    volumeLamports: '9007199254740996',
  });
  const b = row({
    wallet: 'synthetic-wallet-b',
    buyVolumeLamports: '6',
    volumeLamports: '6',
  });
  expect(totals([a, b])).toMatchObject({
    buyVolumeLamports: '9007199254740999',
    sellVolumeLamports: '3',
    volumeLamports: '9007199254741002',
    transactionCount: 4,
  });
});
it('retains finalized transactions while recovery withholds loop counts', () => {
  const a = row({
    completedCycles: 0,
    buyTransactions: 2,
    sellTransactions: 2,
    transactionCount: 4,
    sellVolumeLamports: '100',
    volumeLamports: '200',
    recoveryCount: 1,
    state: 'Recovery required',
  });
  expect(totals([a])).toMatchObject({
    state: 'recovery',
    completedWallets: 0,
    completedCycles: 0,
    recoveryCount: 1,
    recoveryWallets: 1,
  });
});
it('handles the full configured wallet/cycle capacity without rounding', () => {
  const rows = Array.from({ length: 20 }, (_, i) =>
    row({
      wallet: `synthetic-${i}`,
      completedCycles: 20,
      totalCycles: 20,
      buyTransactions: 20,
      sellTransactions: 20,
      transactionCount: 40,
      sellVolumeLamports: '100',
      volumeLamports: '200',
      state: 'Recorded loops complete',
    }),
  );
  expect(totals(rows)).toMatchObject({
    state: 'complete',
    walletCount: 20,
    completedWallets: 20,
    completedCycles: 400,
    totalCycles: 400,
    transactionCount: 800,
    volumeLamports: '4000',
  });
});
it.each([
  'duplicate',
  'capacity',
  'wallet',
  'cycles',
  'mixed-cycles',
  'loops',
  'count',
  'unsafe',
  'fraction',
  'negative',
  'volume',
  'leading-zero',
  'zero-spend',
  'orphan-sell',
  'state',
  'recovery',
] as const)('refuses inconsistent display rows: %s', (kind) => {
  const rows = [row()];
  if (kind === 'duplicate') rows.push(row());
  if (kind === 'capacity')
    for (let i = 0; i < 20; i++) rows.push(row({ wallet: `other-${i}` }));
  if (kind === 'wallet') rows[0].wallet = '';
  if (kind === 'cycles') rows[0].totalCycles = 0;
  if (kind === 'mixed-cycles')
    rows.push(row({ wallet: 'other', totalCycles: 3 }));
  if (kind === 'loops') rows[0].completedCycles = 2;
  if (kind === 'count') rows[0].transactionCount = 2;
  if (kind === 'unsafe') rows[0].buyTransactions = Number.MAX_SAFE_INTEGER + 1;
  if (kind === 'fraction') rows[0].completedCycles = 0.5;
  if (kind === 'negative') rows[0].buyTransactions = -1;
  if (kind === 'volume') rows[0].volumeLamports = '101';
  if (kind === 'leading-zero') rows[0].buyVolumeLamports = '0100';
  if (kind === 'zero-spend')
    Object.assign(rows[0], { buyVolumeLamports: '0', volumeLamports: '0' });
  if (kind === 'orphan-sell')
    Object.assign(rows[0], {
      buyTransactions: 0,
      sellTransactions: 1,
      transactionCount: 1,
      buyVolumeLamports: '0',
      sellVolumeLamports: '100',
    });
  if (kind === 'state') rows[0].state = 'Recorded loops complete';
  if (kind === 'recovery') rows[0].recoveryCount = 1;
  expect(() => totals(rows)).toThrow('totals are unavailable');
});

it('accepts the exact retained-volume bound and refuses the next integer', () => {
  const bound = 4000n * 2n * (10n ** 25n - 1n);
  expect(
    totals([
      row({
        buyVolumeLamports: bound.toString(),
        volumeLamports: bound.toString(),
      }),
    ]).volumeLamports,
  ).toBe(bound.toString());
  expect(() =>
    totals([
      row({
        buyVolumeLamports: (bound + 1n).toString(),
        volumeLamports: (bound + 1n).toString(),
      }),
    ]),
  ).toThrow('totals are unavailable');
});
