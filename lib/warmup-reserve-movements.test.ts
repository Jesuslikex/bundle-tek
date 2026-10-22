import { expect, it } from 'vitest';
import bs58 from 'bs58';
import {
  warmupRentChange,
  WARMUP_NATIVE,
  WARMUP_TOKEN,
} from './warmup-native-settlement';

const key = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const wallet = key(1);
const mint = key(2);
const keys = [wallet, key(3), key(4)];
function token(index: number, amount = '0', tokenMint = mint) {
  return {
    accountIndex: String(index),
    owner: wallet,
    programId: WARMUP_TOKEN,
    mint: tokenMint,
    uiTokenAmount: {
      amount,
      decimals: tokenMint === WARMUP_NATIVE ? '9' : '6',
    },
  };
}

it('preserves a visible rent debit and refund even when their net is zero', () => {
  const result = warmupRentChange(
    keys,
    wallet,
    ['10000000', '0', '2039280'],
    ['9995000', '2039280', '0'],
    [token(2)],
    [token(1)],
  );
  expect(result.rentChange).toBe(0n);
  expect(result.observedWalletTokenReserveIncreases).toBe(2039280n);
  expect(result.observedWalletTokenReserveDecreases).toBe(2039280n);
});

it('excludes wrapped native token units from both reserve movements', () => {
  const result = warmupRentChange(
    keys,
    wallet,
    ['10000000', '0', '3039280'],
    ['9995000', '4039280', '0'],
    [token(2, '1000000', WARMUP_NATIVE)],
    [token(1, '2000000', WARMUP_NATIVE)],
  );
  expect(result.rentChange).toBe(0n);
  expect(result.observedWalletTokenReserveIncreases).toBe(2039280n);
  expect(result.observedWalletTokenReserveDecreases).toBe(2039280n);
});

it('retains exact bigint sums beyond a single uint64 without changing net semantics', () => {
  const max = (1n << 64n) - 1n;
  const result = warmupRentChange(
    keys,
    wallet,
    ['0', '0', '0'],
    ['0', String(max), String(max)],
    [],
    [token(1), token(2)],
  );
  expect(result.observedWalletTokenReserveIncreases).toBe(max * 2n);
  expect(result.observedWalletTokenReserveDecreases).toBe(0n);
  expect(result.rentChange).toBe(max * 2n);
});

it('does not claim to observe an account created and closed between snapshots', () => {
  const result = warmupRentChange(
    keys,
    wallet,
    ['10000000', '0', '0'],
    ['9995000', '0', '0'],
    [],
    [],
  );
  expect(result.rentChange).toBe(0n);
  expect(result.observedWalletTokenReserveIncreases).toBe(0n);
  expect(result.observedWalletTokenReserveDecreases).toBe(0n);
  // Zero observed movement is not zero gross spending evidence.
  expect(Object.keys(result).sort()).toEqual([
    'observedWalletTokenReserveDecreases',
    'observedWalletTokenReserveIncreases',
    'post',
    'pre',
    'rentChange',
  ]);
});

it.each([
  { before: ['0', '1', '0'], after: ['0', '2039280', '0'] },
  { before: ['0', '0', '2039280'], after: ['0', '2039280', '1'] },
])(
  'preserves refusal of incomplete creation/closure metadata: %j',
  (balances) => {
    expect(() =>
      warmupRentChange(
        keys,
        wallet,
        balances.before,
        balances.after,
        [token(2)],
        [token(1)],
      ),
    ).toThrow('complete created and closed account metadata');
  },
);

it('preserves refusal of changed token identity and negative native reserve', () => {
  expect(() =>
    warmupRentChange(
      keys,
      wallet,
      ['0', '10', '0'],
      ['0', '10', '0'],
      [token(1)],
      [token(1, '0', key(5))],
    ),
  ).toThrow('stable account mint identities');
  expect(() =>
    warmupRentChange(
      keys,
      wallet,
      ['0', '10', '0'],
      ['0', '10', '0'],
      [token(1, '11', WARMUP_NATIVE)],
      [token(1, '11', WARMUP_NATIVE)],
    ),
  ).toThrow('valid native token reserves');
});

it('does not label foreign-owner account reserves as wallet token reserves', () => {
  const foreign = { ...token(1), owner: key(9) };
  const result = warmupRentChange(
    keys,
    wallet,
    ['10000000', '0', '0'],
    ['7955720', '2039280', '0'],
    [],
    [foreign],
  );
  expect(result.pre.size).toBe(0);
  expect(result.post.size).toBe(0);
  expect(result.rentChange).toBe(0n);
  expect(result.observedWalletTokenReserveIncreases).toBe(0n);
  expect(result.observedWalletTokenReserveDecreases).toBe(0n);
});
