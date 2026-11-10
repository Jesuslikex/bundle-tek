import { expect, it } from 'vitest';
import {
  distributeBuyAmounts,
  parseDeviationPercent,
  parseDispersion,
  pickDispersedWallets,
} from './buy-dispersion';

const w = (address: string) => ({ address });
const wallets = [w('a'), w('b'), w('c'), w('d')];
const sum = (r: Record<string, bigint>) =>
  Object.values(r).reduce((s, v) => s + v, 0n);

it('parses dispersion: blank is everyone, otherwise 1 to the selection size', () => {
  expect(parseDispersion('', 4)).toBe(4);
  expect(parseDispersion(' 2 ', 4)).toBe(2);
  expect(() => parseDispersion('0', 4)).toThrow(/1 to 4/);
  expect(() => parseDispersion('5', 4)).toThrow(/1 to 4/);
  expect(() => parseDispersion('1.5', 4)).toThrow(/whole number/);
});
it('parses deviation as a whole percent from 1 to 90', () => {
  expect(parseDeviationPercent('25')).toBe(25);
  for (const bad of ['0', '91', '', '2.5'])
    expect(() => parseDeviationPercent(bad)).toThrow();
});
it('Random picks the requested number of distinct wallets', () => {
  const picked = pickDispersedWallets(wallets, 2, 'Random', {}, () => 0);
  expect(picked).toHaveLength(2);
  expect(new Set(picked.map((p) => p.address)).size).toBe(2);
  expect(pickDispersedWallets(wallets, 4, 'Random')).toEqual(wallets);
});
it('Low and High Tokens rank by token balance, ties in selection order', () => {
  const balances = { a: 5n, b: 0n, c: 9n, d: 0n };
  expect(
    pickDispersedWallets(wallets, 2, 'Low Tokens', balances).map(
      (p) => p.address,
    ),
  ).toEqual(['b', 'd']);
  expect(
    pickDispersedWallets(wallets, 2, 'High Tokens', balances).map(
      (p) => p.address,
    ),
  ).toEqual(['c', 'a']);
});
it('Low/High Tokens refuse when a balance is unknown', () => {
  expect(() =>
    pickDispersedWallets(wallets, 2, 'Low Tokens', { a: 1n }),
  ).toThrow(/Refresh balances/);
  expect(() => pickDispersedWallets(wallets, 5, 'Random')).toThrow();
});
it('Equal gives every wallet the entered amount', () => {
  expect(distributeBuyAmounts(['a', 'b'], 100n, 'Equal')).toEqual({
    a: 100n,
    b: 100n,
  });
});
it('Random keeps the exact total and stays inside the deviation', () => {
  const values = [0, 1, 0.5, 0.25];
  let i = 0;
  const out = distributeBuyAmounts(['a', 'b', 'c', 'd'], 1_000_000n, 'Random', {
    deviationPercent: 50,
    random: () => values[i++],
  });
  expect(sum(out)).toBe(4_000_000n);
  expect(out.a).toBeLessThan(out.c);
  expect(out.b).toBeGreaterThan(out.c);
  for (const v of Object.values(out)) expect(v).toBeGreaterThan(0n);
  expect(() =>
    distributeBuyAmounts(['a'], 1n, 'Random', { deviationPercent: 0 }),
  ).toThrow(/Deviation/);
});
it('Weighted splits the same total by SOL balance and needs every balance', () => {
  const out = distributeBuyAmounts(['a', 'b', 'c'], 100n, 'Weighted', {
    nativeBalances: { a: 1n, b: 2n, c: 0n },
  });
  expect(out).toEqual({ a: 100n, b: 200n, c: 0n });
  expect(sum(out)).toBe(300n);
  expect(() =>
    distributeBuyAmounts(['a', 'b'], 100n, 'Weighted', {
      nativeBalances: { a: 1n },
    }),
  ).toThrow(/SOL balances/);
  expect(() =>
    distributeBuyAmounts(['a'], 100n, 'Weighted', {
      nativeBalances: { a: 0n },
    }),
  ).toThrow(/weight/);
});
