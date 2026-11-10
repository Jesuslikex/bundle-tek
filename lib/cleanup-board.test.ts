import { expect, it } from 'vitest';
import {
  boardColumnOf,
  marqueeRect,
  moveBoardWallets,
  nextBoardSelection,
  rectsOverlap,
} from './cleanup-board';

const facts = {
  tokenRaw: { a: '5', b: '0', c: '9' },
  nativeRaw: { a: '1', b: '1', c: '0' },
  max: 2,
};
const empty = { inputs: [], outputs: [] };

it('moves cards into Sources and refuses wallets without tokens', () => {
  const out = moveBoardWallets(empty, ['a', 'b', 'a'], 'sources', facts);
  expect(out.inputs).toEqual(['a']);
  expect(out.refused).toEqual([
    { address: 'b', reason: 'holds no tokens to sell' },
  ]);
});
it('refuses Destinations without native balance', () => {
  const out = moveBoardWallets(empty, ['b', 'c'], 'destinations', facts);
  expect(out.outputs).toEqual(['b']);
  expect(out.refused[0]).toEqual({
    address: 'c',
    reason: 'holds no SOL to buy with',
  });
});
it('keeps a wallet in one column and can send it back to the pool', () => {
  let lists = moveBoardWallets(empty, ['a'], 'sources', facts);
  lists = moveBoardWallets(lists, ['a'], 'destinations', facts);
  expect(lists.inputs).toEqual([]);
  expect(lists.outputs).toEqual(['a']);
  expect(boardColumnOf(lists, 'a')).toBe('destinations');
  lists = moveBoardWallets(lists, ['a'], 'pool', facts);
  expect(boardColumnOf(lists, 'a')).toBe('pool');
});
it('does not check balances that are still loading, and enforces the limit', () => {
  const loading = { tokenRaw: null, nativeRaw: null, max: 2 };
  const out = moveBoardWallets(empty, ['a', 'b', 'c'], 'sources', loading);
  expect(out.inputs).toEqual(['a', 'b']);
  expect(out.refused).toEqual([
    { address: 'c', reason: 'over the 2 wallet limit' },
  ]);
});
it('selects one, toggles with Ctrl/⌘ and ranges with Shift', () => {
  const order = ['a', 'b', 'c', 'd'];
  const none = { shift: false, toggle: false };
  expect(nextBoardSelection(['a'], order, 'a', 'c', none)).toEqual(['c']);
  expect(
    nextBoardSelection(['a'], order, 'a', 'c', { shift: false, toggle: true }),
  ).toEqual(['a', 'c']);
  expect(
    nextBoardSelection(['a', 'c'], order, 'c', 'c', {
      shift: false,
      toggle: true,
    }),
  ).toEqual(['a']);
  expect(
    nextBoardSelection(['d'], order, 'd', 'b', { shift: true, toggle: false }),
  ).toEqual(['b', 'c', 'd']);
  expect(
    nextBoardSelection(['a'], order, null, 'b', { shift: true, toggle: false }),
  ).toEqual(['b']);
});
it('builds the drag box and detects overlapping cards', () => {
  const box = marqueeRect({ x: 50, y: 40 }, { x: 10, y: 5 });
  expect(box).toEqual({ left: 10, top: 5, right: 50, bottom: 40 });
  expect(rectsOverlap(box, { left: 45, top: 30, right: 80, bottom: 90 })).toBe(
    true,
  );
  expect(rectsOverlap(box, { left: 51, top: 0, right: 80, bottom: 90 })).toBe(
    false,
  );
});
