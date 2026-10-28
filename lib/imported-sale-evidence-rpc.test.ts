import { afterEach, expect, it, vi } from 'vitest';
import {
  createImportedSaleEvidenceRpc,
  awaitImportedSaleRead,
} from './imported-sale-evidence-rpc';
vi.mock('./wallet-rpc-pacing', () => ({
  paceWalletRpc: vi.fn(async () => {}),
}));
afterEach(() => vi.restoreAllMocks());
const signal = () => new AbortController().signal;
const params = [
  '1'.repeat(88),
  {
    encoding: 'base64',
    commitment: 'finalized',
    maxSupportedTransactionVersion: 0,
  },
];
it('permits only the collector’s exact finalized read methods and parameters', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ jsonrpc: '2.0', id: 1, result: 'ok' }),
  );
  const rpc = createImportedSaleEvidenceRpc(
    'https://rpc.example/private',
    fetcher,
  );
  expect(await rpc('getGenesisHash', [], signal())).toBe('ok');
  expect(await rpc('getTransaction', params, signal())).toBe('ok');
  for (const [method, p] of [
    ['sendTransaction', params],
    ['getSlot', []],
    ['getGenesisHash', [1]],
    ['getTransaction', ['invalid', params[1]]],
    [
      'getTransaction',
      [params[0], { ...(params[1] as object), commitment: 'confirmed' }],
    ],
    ['getTransaction', [params[0], { ...(params[1] as object), extra: true }]],
  ] as [string, unknown[]][])
    await expect(rpc(method, p, signal())).rejects.toMatchObject({
      status: 400,
    });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    redirect: 'manual',
    cache: 'no-store',
    signal: expect.any(AbortSignal),
  });
});
it('rejects invalid server endpoint configuration without echoing its credential', () => {
  for (const url of [
    'http://rpc.example/private',
    'https://user:secret@rpc.example/',
    'https://rpc.example/#secret',
    'bad-secret',
  ])
    expect(() => createImportedSaleEvidenceRpc(url)).toThrow(
      'Sale evidence RPC configuration is unavailable.',
    );
});
it('preserves raw integer spelling and refuses excess bytes, wrong IDs, RPC errors and redirects', async () => {
  const valid = createImportedSaleEvidenceRpc(
    'https://rpc.example',
    async () =>
      new Response(
        '{"jsonrpc":"2.0","id":1,"result":{"slot":9007199254740993}}',
      ),
  );
  expect(await valid('getGenesisHash', [], signal())).toEqual({
    slot: '9007199254740993',
  });
  for (const response of [
    new Response('x'.repeat(524289)),
    Response.json({ jsonrpc: '2.0', id: 2, result: 'bad' }),
    Response.json({ jsonrpc: '2.0', id: 1, error: { message: 'secret' } }),
    new Response('', {
      status: 302,
      headers: { location: 'https://elsewhere.example' },
    }),
  ]) {
    const fetcher = vi.fn(async () => response);
    await expect(
      createImportedSaleEvidenceRpc('https://rpc.example', fetcher)(
        'getGenesisHash',
        [],
        signal(),
      ),
    ).rejects.toThrow();
    // At most one retry, then the failure is surfaced.
    expect(fetcher).toHaveBeenCalled();
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(2);
  }
});
it('does not retry a 429 and observes cancellation even when the transport ignores it', async () => {
  const fetcher = vi.fn(async () => new Response('', { status: 429 }));
  await expect(
    createImportedSaleEvidenceRpc('https://rpc.example', fetcher)(
      'getGenesisHash',
      [],
      signal(),
    ),
  ).rejects.toMatchObject({ status: 429 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const c = new AbortController();
  const promise = awaitImportedSaleRead(new Promise<never>(() => {}), c.signal);
  c.abort();
  await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
});
