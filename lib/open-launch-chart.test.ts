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

it('opens an archived import for explicit restoration without writing', async () => {
  const archived = { ...project('archived', 'Mint'), archived: true };
  const fetcher = vi.fn(async () => Response.json({ projects: [archived] }));
  vi.stubGlobal('fetch', fetcher);
  const listener = vi.fn();
  window.addEventListener(OPEN_IMPORTED_PROJECT_EVENT, listener);
  expect(await openLaunchChart('Mint')).toBe('archived');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
    id: 'archived',
  });
  window.removeEventListener(OPEN_IMPORTED_PROJECT_EVENT, listener);
});

it('does not import or navigate after a cancelled list request completes late', async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const listener = vi.fn();
  window.addEventListener(OPEN_IMPORTED_PROJECT_EVENT, listener);
  const controller = new AbortController();
  const pending = openLaunchChart('Mint', controller.signal);
  controller.abort();
  finish(Response.json({ projects: [] }));
  await expect(pending).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(listener).not.toHaveBeenCalled();
  window.removeEventListener(OPEN_IMPORTED_PROJECT_EVENT, listener);
});

it('does not navigate after a cancelled import completes late', async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ projects: [] }))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
  vi.stubGlobal('fetch', fetcher);
  const listener = vi.fn();
  window.addEventListener(OPEN_IMPORTED_PROJECT_EVENT, listener);
  const controller = new AbortController();
  const pending = openLaunchChart('Mint', controller.signal);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  controller.abort();
  finish(Response.json({ project: project('c', 'Mint') }));
  await expect(pending).rejects.toThrow();
  expect(listener).not.toHaveBeenCalled();
  window.removeEventListener(OPEN_IMPORTED_PROJECT_EVENT, listener);
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

it('refuses malformed project lists and an imported result from another chain', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({}))
    .mockResolvedValueOnce(Response.json({ projects: [] }))
    .mockResolvedValueOnce(
      Response.json({
        project: {
          ...project('c', 'Mint'),
          document: { token: { chain: 'Base', address: 'Mint' } },
        },
      }),
    );
  vi.stubGlobal('fetch', fetcher);
  await expect(openLaunchChart('Mint')).rejects.toThrow(
    /could not be verified/,
  );
  await expect(openLaunchChart('Mint')).rejects.toThrow(/differs/);
});
