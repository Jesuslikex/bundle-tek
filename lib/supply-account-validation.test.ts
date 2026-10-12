import { expect, it } from 'vitest';
import {
  largestSupplyOwners,
  supplyAccountBalance,
  supplyTokenAmount,
} from './supply-account-validation';
import { TOKEN_PROGRAMS } from './wallet-holdings';
import { supplyWallet } from '../test/supply-history-fixture';
const mint = supplyWallet(9),
  owner = supplyWallet(1),
  address = supplyWallet(2);
const account = (amount = '400') => ({
  owner: TOKEN_PROGRAMS[0],
  executable: false,
  data: {
    parsed: {
      type: 'account',
      info: {
        mint,
        owner,
        state: 'initialized',
        tokenAmount: { amount, decimals: 0 },
      },
    },
  },
});
const rows = [{ address, amount: '400', decimals: 0 }];
it('groups actual wallet owners and accepts frozen balances as held supply', () => {
  const frozen = account('100');
  frozen.data.parsed.info.state = 'frozen';
  expect(
    largestSupplyOwners(
      [...rows, { address: supplyWallet(3), amount: '100', decimals: 0 }],
      [account(), frozen],
      mint,
      0,
      1000n,
    ),
  ).toEqual(new Map([[owner, 500n]]));
});
it('rejects missing owner details instead of replacing owners with token accounts', () => {
  expect(() => largestSupplyOwners(rows, [null], mint, 0, 1000n)).toThrow();
  expect(() => largestSupplyOwners(rows, [], mint, 0, 1000n)).toThrow();
});
it('rejects duplicate accounts, changed balances and impossible totals', () => {
  expect(() =>
    largestSupplyOwners(
      [...rows, ...rows],
      [account(), account()],
      mint,
      0,
      1000n,
    ),
  ).toThrow('Duplicate');
  expect(() =>
    largestSupplyOwners(rows, [account('399')], mint, 0, 1000n),
  ).toThrow('changed');
  expect(() => largestSupplyOwners(rows, [account()], mint, 0, 399n)).toThrow(
    'exceed',
  );
});
it('binds token program, mint, state, precision and expected wallet', () => {
  expect(() =>
    supplyAccountBalance({ ...account(), owner: 'foreign' }, mint, 0),
  ).toThrow();
  expect(() => supplyAccountBalance(account(), supplyWallet(8), 0)).toThrow();
  expect(() => supplyAccountBalance(account(), mint, 6)).toThrow();
  expect(() =>
    supplyAccountBalance(account(), mint, 0, supplyWallet(4)),
  ).toThrow();
});
it('rejects numeric amounts, malformed integer strings and u64 overflow', () => {
  for (const amount of [1, '-1', '01', '18446744073709551616'])
    expect(() => supplyTokenAmount({ amount, decimals: 0 })).toThrow();
});
