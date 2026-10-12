import { expect, it } from 'vitest';
import { assessSimulatedSwapTokens } from './simulated-swap-balances';
import { WRAPPED_SOL } from './warmup-swap-quote';
const wallet = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
const account = '8phnoC6V8nwYnNUwobNBoWzWAmyP1nj9GyYZaMbU8z4';
const other = '11111111111111111111111111111111';
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const program = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const order = {
  inputMint: WRAPPED_SOL,
  outputMint: mint,
  inAmount: '1000',
  minimumOutAmount: '100',
  preparation: { wallet, accountCount: 2 },
};
const balance = (amount: string, patch = {}) => ({
  accountIndex: '1',
  mint,
  owner: wallet,
  programId: program,
  uiTokenAmount: { amount, decimals: '6' },
  ...patch,
});
const assess = (pre: unknown, post: unknown) =>
  assessSimulatedSwapTokens(order, [wallet, account], [], {
    preTokenBalances: pre,
    postTokenBalances: post,
  });
it('compares exact simulated wallet output above safe Number precision', () => {
  const result = assess(
    [balance('9007199254740993')],
    [balance('9007199254741093')],
  );
  expect(result).toMatchObject({
    tokensComplete: true,
    inputAmountMatches: null,
    minimumOutputCovered: true,
  });
  expect(result.tokenChanges[0].changeRaw).toBe('100');
  expect(assess([balance('0')], [balance('99')]).minimumOutputCovered).toBe(
    false,
  );
});
it('uses loaded writable then readonly keys and rejects incomplete lookup mapping', () => {
  const lookup = [{ writableIndexes: [7], readonlyIndexes: [] }];
  const value = {
    loadedAddresses: { writable: [account], readonly: [] },
    preTokenBalances: [],
    postTokenBalances: [balance('100')],
  };
  expect(
    assessSimulatedSwapTokens(order, [wallet], lookup, value).tokenChanges[0]
      .accounts,
  ).toEqual([account]);
  expect(() =>
    assessSimulatedSwapTokens(order, [wallet], lookup, {
      ...value,
      loadedAddresses: { writable: [], readonly: [] },
    }),
  ).toThrow();
  expect(() =>
    assessSimulatedSwapTokens(order, [wallet], lookup, {
      ...value,
      loadedAddresses: { writable: [wallet], readonly: [] },
    }),
  ).toThrow();
});
it('excludes another owner and accounts for newly created, closed and reassigned accounts', () => {
  expect(
    assess([], [balance('100', { owner: other })]).minimumOutputCovered,
  ).toBe(false);
  expect(assess([], [balance('100')]).tokenChanges[0].changeRaw).toBe('100');
  const sell = {
    ...order,
    inputMint: mint,
    outputMint: WRAPPED_SOL,
    inAmount: '100',
  };
  expect(
    assessSimulatedSwapTokens(sell, [wallet, account], [], {
      preTokenBalances: [balance('100')],
      postTokenBalances: [],
    }),
  ).toMatchObject({ inputAmountMatches: true, minimumOutputCovered: null });
  expect(
    assess([balance('100')], [balance('100', { owner: other })]).tokenChanges[0]
      .changeRaw,
  ).toBe('-100');
});
it('withholds all comparisons for absent or incomplete ownership metadata', () => {
  for (const result of [
    assess(undefined, []),
    assess([], undefined),
    assess([], [balance('100', { owner: null })]),
    assess([], [balance('100', { programId: null })]),
  ])
    expect(result).toMatchObject({
      tokensComplete: false,
      tokenChanges: [],
      inputAmountMatches: null,
      minimumOutputCovered: null,
    });
});
it('rejects malformed, duplicated and inconsistent token records', () => {
  for (const records of [
    [balance('01')],
    [balance('-1')],
    [balance('18446744073709551616')],
    [balance('1', { accountIndex: '2' })],
    [balance('1'), balance('2')],
  ])
    expect(() => assess([], records)).toThrow();
  expect(() =>
    assess(
      [balance('1')],
      [balance('2', { uiTokenAmount: { amount: '2', decimals: '5' } })],
    ),
  ).toThrow();
});
