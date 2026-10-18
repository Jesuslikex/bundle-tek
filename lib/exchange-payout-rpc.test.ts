import { it, expect, vi } from 'vitest';
import { createExchangePayoutRpc } from './exchange-payout-rpc';
import { paceWalletRpc } from './wallet-rpc-pacing';
vi.mock('./wallet-rpc-pacing', () => ({
  paceWalletRpc: vi.fn(async () => {}),
}));
const endpoint = 'https://rpc.example.invalid/private-fixture';
it('uses only bounded read methods and ordinary configured pacing with lossless numeric JSON', async () => {
  const signal = new AbortController().signal;
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        '{"jsonrpc":"2.0","id":1,"result":{"preBalances":[9007199254740993]}}',
      ),
  );
  const rpc = createExchangePayoutRpc(endpoint, fetcher);
  expect(
    await rpc(
      'getTransaction',
      ['fixture', { commitment: 'finalized' }],
      signal,
    ),
  ).toEqual({ preBalances: ['9007199254740993'] });
  expect(paceWalletRpc).toHaveBeenLastCalledWith(endpoint, signal);
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    redirect: 'manual',
    cache: 'no-store',
    signal,
  });
  const before = fetcher.mock.calls.length;
  for (const method of [
    'sendTransaction',
    'sendBundle',
    'simulateTransaction',
    'requestAirdrop',
  ])
    await expect(rpc(method, [], signal)).rejects.toMatchObject({
      status: 400,
    });
  expect(fetcher).toHaveBeenCalledTimes(before);
});
it('refuses invalid endpoints and oversized responses without exposing provider content', async () => {
  for (const url of [
    'http://rpc.example.invalid',
    'https://user:pass@rpc.example.invalid',
    'https://rpc.example.invalid/#fragment',
  ])
    expect(() => createExchangePayoutRpc(url)).toThrow('configuration');
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response('x'.repeat(524289)),
  );
  await expect(
    createExchangePayoutRpc(endpoint, fetcher)(
      'getGenesisHash',
      [],
      new AbortController().signal,
    ),
  ).rejects.toThrow('too large');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('does not retry a 429 or follow redirects', async () => {
  for (const status of [429, 302]) {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response('private diagnostic', { status }),
    );
    await expect(
      createExchangePayoutRpc(endpoint, fetcher)(
        'getGenesisHash',
        [],
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ status });
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});
it('settles cancellation even when transport ignores abort and refuses an already aborted read', async () => {
  const controller = new AbortController(),
    fetcher = vi.fn(() => new Promise<Response>(() => {}));
  const rpc = createExchangePayoutRpc(endpoint, fetcher),
    read = rpc('getGenesisHash', [], controller.signal);
  controller.abort();
  await expect(read).rejects.toMatchObject({ status: 503 });
  const before = fetcher.mock.calls.length;
  await expect(
    rpc('getGenesisHash', [], controller.signal),
  ).rejects.toBeDefined();
  expect(fetcher).toHaveBeenCalledTimes(before);
});
