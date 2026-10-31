// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  OPEN_IMPORTED_PROJECT_EVENT,
  openLaunchChart,
} from './open-launch-chart';

const project = (id: string, address: string) => ({
  id,
  archived: false,
  document: { token: { chain: 'Solana', address } },
});
afterEach(() => vi.unstubAllGlobals());

it('opens an already imported coin without importing it again', async () => {
  const fetcher = vi.fn(async () =>
    Response.json({ projects: [project('a', 'Other'), project('b', 'Mint')] }),
  );
  vi.stubGlobal('fetch', fetcher);
  const seen: unknown[] = [];
  const listener = (e: Event) => seen.push((e as CustomEvent).detail);
  window.addEventListener(OPEN_IMPORTED_PROJECT_EVENT, listener);
  expect(await openLaunchChart('Mint')).toBe('b');
  window.removeEventListener(OPEN_IMPORTED_PROJECT_EVENT, listener);
  expect(seen).toEqual([{ id: 'b' }]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('imports a new coin once and refuses a different token', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ projects: [] }))
    .mockResolvedValueOnce(Response.json({ project: project('c', 'Mint') }))
    .mockResolvedValueOnce(Response.json({ projects: [] }))
    .mockResolvedValueOnce(Response.json({ project: project('d', 'Wrong') }));
  vi.stubGlobal('fetch', fetcher);
  expect(await openLaunchChart('Mint')).toBe('c');
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
    action: 'import',
    chain: 'Solana',
    address: 'Mint',
  });
  await expect(openLaunchChart('Mint')).rejects.toThrow(/differs/);
});
