// @vitest-environment jsdom
/**
 * Guards the fix in `test/jsdom-localstorage.ts`.
 *
 * On Node 26 a jsdom suite without that setup file gets `localStorage`
 * `undefined` and Node's own `sessionStorage`, so suites fail during `beforeEach`
 * (or silently observe `Storage.prototype` spies as no-ops) instead of testing
 * what they claim. These assertions fail loudly if the setup file is dropped or
 * stops reaching jsdom's real storage.
 */
import { expect, it, vi } from 'vitest';

it('provides a working localStorage backed by the Storage class', () => {
  expect(typeof localStorage).toBe('object');
  expect(localStorage).toBeInstanceOf(Storage);
  localStorage.setItem('probe', 'value');
  expect(localStorage.getItem('probe')).toBe('value');
  expect(localStorage.length).toBe(1);
  localStorage.removeItem('probe');
  expect(localStorage.getItem('probe')).toBeNull();
});

it('also restores sessionStorage so both storages share the Storage class', () => {
  // Node's own sessionStorage is a different class, which is what made
  // `vi.spyOn(Storage.prototype, …)` silently miss it.
  expect(sessionStorage).toBeInstanceOf(Storage);
});

it('lets Storage.prototype spies intercept both storages', () => {
  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  try {
    expect(() => localStorage.setItem('a', 'b')).toThrow('blocked');
    expect(() => sessionStorage.setItem('a', 'b')).toThrow('blocked');
  } finally {
    spy.mockRestore();
  }
});

it('keeps storage empty at the start of a file so files cannot leak into each other', () => {
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});
