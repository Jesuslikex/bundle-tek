import { expect, it } from 'vitest';
import {
  indexedHolderSupplyShare,
  selectIndexedHolders,
} from './holder-index-view';

it('orders u64 holdings without losing one-unit differences or mutating the index', () => {
  const rows = [
    { owner: 'B', raw: 9007199254740992n, accountCount: 1 },
    { owner: 'A', raw: 9007199254740993n, accountCount: 2 },
    { owner: 'C', raw: 9007199254740993n, accountCount: 3 },
  ];
  expect(selectIndexedHolders(rows, '', 'largest').map((x) => x.owner)).toEqual(
    ['A', 'C', 'B'],
  );
  expect(
    selectIndexedHolders(rows, '', 'smallest').map((x) => x.owner),
  ).toEqual(['B', 'A', 'C']);
  expect(
    selectIndexedHolders(rows, '', 'accounts').map((x) => x.owner),
  ).toEqual(['C', 'A', 'B']);
  expect(
    selectIndexedHolders(rows, ' A ', 'owner').map((x) => x.owner),
  ).toEqual(['A']);
  expect(rows.map((x) => x.owner)).toEqual(['B', 'A', 'C']);
});

it('uses reference mint supply rather than scanned totals, preserving tiny positive balances', () => {
  expect(indexedHolderSupplyShare(1n, '18446744073709551615')).toBe('<0.0001%');
  expect(indexedHolderSupplyShare(250n, '1000')).toBe('25.0000%');
  expect(indexedHolderSupplyShare(1n, '3')).toBe('33.3333%');
  expect(indexedHolderSupplyShare(0n, '1000')).toBe('0.0000%');
  expect(indexedHolderSupplyShare(1000n, '1000')).toBe('100.0000%');
  expect(indexedHolderSupplyShare(1n, '0')).toBe('Unavailable');
  expect(indexedHolderSupplyShare(1001n, '1000')).toBe('Unavailable');
});
