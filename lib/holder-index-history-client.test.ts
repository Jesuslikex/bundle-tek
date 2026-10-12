import { expect, it, vi } from 'vitest';
import { readHolderIndexHistory } from './holder-index-history-client';
import type { HolderIndexPage } from './holder-index';
import { supplyWallet } from '../test/supply-history-fixture';
const run = '00000000-0000-4000-8000-000000000001';
const project = {
  id: 'project',
  revision: 1,
  mint: supplyWallet(9),
  decimals: 6,
};
const page = (n: number): HolderIndexPage => ({
  mint: project.mint,
  page: n,
  decimals: 6,
  totalSupplyRaw: '1000000',
  supplySlot: 200,
  indexedSlot: 190,
  observedAt: '2026-10-12T04:00:00Z',
  source: 'index.test',
  accounts: [
    {
      address: supplyWallet(n),
      owner: supplyWallet(7),
      raw: '100',
      frozen: false,
    },
  ],
});
const payload = (
  pages: HolderIndexPage[],
  nextCursor: number | null = null,
  total = pages.length,
) => ({
  id: project.id,
  revision: 1,
  runId: run,
  runs: [
    {
      id: run,
      revision: 1,
      pages: total,
      status: 'partial',
      updatedAt: '2026-10-12T04:00:00Z',
      createdAt: '2026-10-12T04:00:00Z',
    },
  ],
  pages,
  nextCursor,
});
it('restores multiple saved pages without provider POSTs or double counting', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(payload([page(1)], 1, 2)))
    .mockResolvedValueOnce(Response.json(payload([page(2)], null, 2)));
  const result = await readHolderIndexHistory(
    project,
    null,
    new AbortController().signal,
    fetcher,
  );
  expect(result.scan?.indexedRaw).toBe(200n);
  expect(result.scan?.accounts.size).toBe(2);
  expect(fetcher.mock.calls[1][0]).toContain('cursor=1');
  expect(fetcher.mock.calls.every((call) => call[1].method === undefined)).toBe(
    true,
  );
});
it('rejects missing pages and looping pagination rather than showing incomplete restored history as whole', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(Response.json(payload([page(1)], null, 2)));
  await expect(
    readHolderIndexHistory(project, run, new AbortController().signal, fetcher),
  ).rejects.toThrow('incomplete');
  const looping = vi
    .fn()
    .mockResolvedValue(Response.json(payload([page(1)], 0, 2)));
  await expect(
    readHolderIndexHistory(project, run, new AbortController().signal, looping),
  ).rejects.toThrow('pagination');
});
it('rejects pages or a response that belong to another project', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      Response.json({ ...payload([page(1)]), id: 'other-project' }),
    );
  await expect(
    readHolderIndexHistory(project, run, new AbortController().signal, fetcher),
  ).rejects.toThrow('context differs');
});
