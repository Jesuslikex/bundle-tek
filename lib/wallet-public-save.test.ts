import { afterEach, expect, it, vi } from 'vitest';
import { saveWalletPublicAddresses } from './wallet-public-save';
import type { WalletWorkspace } from './wallet-workspace';

const address = '11111111111111111111111111111111';
const args = { chain: 'Solana' as const, addresses: [address], folderId: '' };
const workspace = (archived = false): WalletWorkspace => ({
  folders: [],
  wallets: [
    {
      chain: 'Solana',
      address,
      archived,
      revision: 1,
      folderId: '',
      label: '',
      role: 'Recipient',
      updatedAt: '',
    },
  ],
});
const empty = () => Response.json({ folders: [], wallets: [] });
const saved = () => Response.json(workspace());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('reconciles an earlier successful save without sending it again', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(saved());
  vi.stubGlobal('fetch', fetcher);
  await expect(saveWalletPublicAddresses(args)).resolves.toEqual(workspace());
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('saves only public metadata and confirms against a fresh owned read', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(empty())
    .mockResolvedValueOnce(Response.json({ ok: true }))
    .mockResolvedValueOnce(saved());
  vi.stubGlobal('fetch', fetcher);
  await expect(saveWalletPublicAddresses(args)).resolves.toEqual(workspace());
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
    chain: 'Solana',
    action: 'wallet.add',
    folderId: '',
    wallets: [{ address, label: '', role: 'Recipient' }],
  });
});
it.each([409, 500])(
  'requires fresh confirmation even after HTTP %s',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(empty())
        .mockResolvedValueOnce(new Response('private error', { status }))
        .mockResolvedValueOnce(saved()),
    );
    await expect(saveWalletPublicAddresses(args)).resolves.toEqual(workspace());
  },
);
it('recovers an ambiguous transport failure with a fresh read', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(empty())
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(saved()),
  );
  await expect(saveWalletPublicAddresses(args)).resolves.toEqual(workspace());
});
it('does not treat a duplicate response with no saved address as success', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(new Response('', { status: 409 }))
      .mockResolvedValueOnce(empty()),
  );
  await expect(saveWalletPublicAddresses(args)).rejects.toThrow(
    'Could not confirm',
  );
});
it('refuses archived addresses without silently restoring or resending them', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(workspace(true)));
  vi.stubGlobal('fetch', fetcher);
  await expect(saveWalletPublicAddresses(args)).rejects.toThrow('Restore it');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each(['chain', 'revision', 'partial'])(
  'does not accept a mismatched %s confirmation',
  async (mismatch) => {
    const wrong = workspace();
    if (mismatch === 'chain') wrong.wallets[0].chain = 'Base';
    if (mismatch === 'revision') wrong.wallets[0].revision = 0;
    const request =
      mismatch === 'partial'
        ? {
            ...args,
            addresses: [address, 'So11111111111111111111111111111111111111112'],
          }
        : args;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(empty())
        .mockResolvedValueOnce(Response.json({}))
        .mockResolvedValueOnce(Response.json(wrong)),
    );
    await expect(saveWalletPublicAddresses(request)).rejects.toThrow(
      'Could not confirm',
    );
  },
);
it.each([401, 200])(
  'sanitizes unavailable or non-JSON workspace responses (%s)',
  async (status) => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('secret service body', { status }));
    vi.stubGlobal('fetch', fetcher);
    await expect(saveWalletPublicAddresses(args)).rejects.toThrow(
      status === 401 ? 'Sign in' : 'Could not confirm',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it('a stalled POST releases the UI and reconciles without a second POST', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(empty())
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValueOnce(saved());
  vi.stubGlobal('fetch', fetcher);
  const result = expect(saveWalletPublicAddresses(args)).resolves.toEqual(
    workspace(),
  );
  await vi.advanceTimersByTimeAsync(5_000);
  await result;
  expect(
    fetcher.mock.calls.filter((call) => call[1]?.method === 'POST'),
  ).toHaveLength(1);
});
it('a stalled response body fails within the deadline, then a manual retry only reads', async () => {
  vi.useFakeTimers();
  const stalledBody = { ok: true, json: () => new Promise(() => {}) };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(empty())
    .mockResolvedValueOnce(Response.json({}))
    .mockResolvedValueOnce(stalledBody)
    .mockResolvedValueOnce(saved());
  vi.stubGlobal('fetch', fetcher);
  const first = expect(saveWalletPublicAddresses(args)).rejects.toThrow(
    'Could not confirm',
  );
  await vi.advanceTimersByTimeAsync(5_000);
  await first;
  await expect(saveWalletPublicAddresses(args)).resolves.toEqual(workspace());
  expect(
    fetcher.mock.calls.filter((call) => call[1]?.method === 'POST'),
  ).toHaveLength(1);
});
it('cancels pending work without posting or accepting late completion', async () => {
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn().mockImplementation(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController();
  const result = expect(
    saveWalletPublicAddresses({ ...args, signal: controller.signal }),
  ).rejects.toThrow('Could not confirm');
  controller.abort();
  await result;
  resolve(saved());
  expect(fetcher).toHaveBeenCalledTimes(1);
});
