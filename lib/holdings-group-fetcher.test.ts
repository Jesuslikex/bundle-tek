import { expect, it, vi } from 'vitest';
import bs58 from 'bs58';
vi.mock('./solana-rpc', () => ({
  getSolanaIndexerRpcEndpoint: () => 'https://rpc.test/',
}));
import { observeWalletHoldings } from './wallet-holdings';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { createHoldingsGroupFetcher } from './holdings-group-fetcher';
const addresses = Array.from({ length: 25 }, (_, i) =>
  bs58.encode(new Uint8Array(32).fill(i + 1)),
);
function provider(patch?: (results: Record<string, unknown>[]) => unknown) {
  const calls: unknown[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    if (typeof init?.body !== 'string')
      throw new Error('Expected a JSON request body.');
    const body = JSON.parse(init.body);
    calls.push(body);
    expect(init?.redirect).toBe('manual');
    if (!Array.isArray(body))
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: body.method === 'getGenesisHash' ? SOLANA_MAINNET_GENESIS : 100,
      });
    const results = body
      .map((c, index) => ({
        jsonrpc: '2.0',
        id: c.id,
        result: { context: { slot: 100 + index }, value: [] },
      }))
      .reverse();
    return Response.json(patch ? patch(results) : results);
  }) as typeof fetch;
  return { calls, fetcher };
}
it('observes all 25 wallets with only two shared checks and 25 paired HTTP calls', async () => {
  const { calls, fetcher } = provider(),
    group = createHoldingsGroupFetcher(fetcher),
    signal = AbortSignal.timeout(10000);
  const snapshots = await Promise.all(
    addresses.map((address) => observeWalletHoldings(address, signal, group)),
  );
  expect(snapshots.map((s) => s.address)).toEqual(addresses);
  expect(
    snapshots.every(
      (s) => s.accountCount === 0 && s.minSlot === 100 && s.maxSlot === 101,
    ),
  ).toBe(true);
  expect(calls).toHaveLength(27);
  expect(calls.filter(Array.isArray)).toHaveLength(25);
  for (const batch of calls.filter(Array.isArray)) {
    expect(batch).toHaveLength(2);
    expect(batch[0].params[0]).toBe(batch[1].params[0]);
    expect(batch.every((c) => c.params[2].minContextSlot === 100)).toBe(true);
  }
});
it.each([
  (r: Record<string, unknown>[]) => r.slice(0, 1),
  (r: Record<string, unknown>[]) => [r[0], r[0]],
  (r: Record<string, unknown>[]) => r.map((v) => ({ ...v, id: 'foreign' })),
  (r: Record<string, unknown>[]) =>
    r.map((v) => ({ ...v, error: { message: 'private upstream detail' } })),
  (r: Record<string, unknown>[]) => r.map((v) => ({ ...v, jsonrpc: '1.0' })),
])(
  'rejects incomplete, duplicate, mismatched or failed batches without returning holdings',
  async (patch) => {
    const { fetcher } = provider(patch);
    await expect(
      observeWalletHoldings(
        addresses[0],
        AbortSignal.timeout(1000),
        createHoldingsGroupFetcher(fetcher),
      ),
    ).rejects.toThrow('provider request failed');
  },
);
it('preserves provider u64 token units through batch decoding without float conversion', async () => {
  const { fetcher } = provider((results) =>
    results.map((r) => {
      if (r.id !== 'holdings-0') return r;
      return {
        ...r,
        result: {
          context: { slot: 100 },
          value: [
            {
              pubkey: addresses[1],
              account: {
                owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                executable: false,
                data: {
                  space: 165,
                  parsed: {
                    type: 'account',
                    info: {
                      owner: addresses[0],
                      mint: addresses[2],
                      state: 'initialized',
                      tokenAmount: {
                        amount: '18446744073709551615',
                        decimals: 9,
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      };
    }),
  );
  const s = await observeWalletHoldings(
    addresses[0],
    AbortSignal.timeout(1000),
    createHoldingsGroupFetcher(fetcher),
  );
  expect(s.holdings[0].raw).toBe('18446744073709551615');
  expect(s.holdings[0].amount).toBe('18446744073.709551615');
});
it('aborts an unpaired read and rejects writes or changed transport scope', async () => {
  const { fetcher } = provider(),
    group = createHoldingsGroupFetcher(fetcher),
    controller = new AbortController();
  const call = (method: string, params: unknown[]) => ({
    method: 'POST',
    signal: controller.signal,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  await expect(
    group('https://rpc.test/', call('sendTransaction', [])),
  ).rejects.toThrow('Unsupported');
  await expect(
    group('https://other-rpc.test/', call('getGenesisHash', [])),
  ).rejects.toThrow('context changed');
  const pending = group(
    'https://rpc.test/',
    call('getTokenAccountsByOwner', [
      addresses[0],
      { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
    ]),
  );
  controller.abort();
  await expect(pending).rejects.toThrow();
});
it.each([
  ['RESULT_TOO_LARGE', false],
  ['BATCH_TOO_LARGE', true],
] as const)(
  'reports bounded %s failures without weakening response limits',
  async (code, both) => {
    const { fetcher } = provider((results) =>
      results.map((r) =>
        r.id === 'holdings-0' || both
          ? {
              ...r,
              result: { ...(r.result as object), padding: 'x'.repeat(530000) },
            }
          : r,
      ),
    );
    await expect(
      observeWalletHoldings(
        addresses[0],
        AbortSignal.timeout(1000),
        createHoldingsGroupFetcher(fetcher),
      ),
    ).rejects.toMatchObject({ code });
  },
);
