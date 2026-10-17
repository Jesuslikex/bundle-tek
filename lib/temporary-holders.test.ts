import { expect, it } from 'vitest';
import {
  readTemporaryHolders,
  saveTemporaryHolders,
} from './temporary-holders';

const A = 'Vote111111111111111111111111111111111111111';
const B = 'Stake11111111111111111111111111111111111111';
const store = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
};

it('remembers unique temporary holders per mint and clears empty choices', () => {
  const s = store();
  expect(saveTemporaryHolders('mint1', [A, B, A], s)).toEqual([A, B]);
  expect(readTemporaryHolders('mint1', s)).toEqual([A, B]);
  expect(readTemporaryHolders('mint2', s)).toEqual([]);
  saveTemporaryHolders('mint1', [], s);
  expect(s.map.size).toBe(0);
  expect(() => saveTemporaryHolders('mint1', ['x'], s)).toThrow();
});

it('ignores tampered or malformed stored values', () => {
  const s = store();
  s.setItem('bundle.temporary-holders.v1:m', '{"a":1}');
  expect(readTemporaryHolders('m', s)).toEqual([]);
  s.setItem('bundle.temporary-holders.v1:m', JSON.stringify([A, 'bad']));
  expect(readTemporaryHolders('m', s)).toEqual([]);
  s.setItem('bundle.temporary-holders.v1:m', JSON.stringify([A, A]));
  expect(readTemporaryHolders('m', s)).toEqual([]);
});
