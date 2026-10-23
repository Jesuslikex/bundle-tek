import { expect, it, vi } from 'vitest';
import {
  decodeWarmupHistory,
  readWarmupHistory,
} from './warmup-history-client';
import { warmupUiFixture } from '../test/warmup-ui-fixture';

const wallet = warmupUiFixture().wallet;
function packet() {
  return {
    chain: 'Solana',
    results: [
      {
        address: wallet,
        observation: {
          address: wallet,
          chain: 'Solana',
          observedAt: '2026-10-23T12:00:00.000Z',
          source: 'fixture.test',
          nativeBalance: '0.02',
          currency: 'SOL',
          block: '100',
          outgoingTransactions: null,
          sampleCount: 2,
          successfulSampleCount: 1,
          oldestObservedAt: '2026-10-23T11:00:00.000Z',
          latestObservedAt: '2026-10-23T11:59:00.000Z',
          coverage: 'Latest 50 finalized signatures only. Wallet age unknown.',
        },
      },
    ],
  };
}
it('admits actual server-shaped ordered history without inferring wallet age', () => {
  expect(
    decodeWarmupHistory(packet(), 'Solana', [wallet])[0].observation
      ?.sampleCount,
  ).toBe(2);
});
it.each([
  [
    'nested address',
    { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  ],
  ['nested chain', { chain: 'Base' }],
  ['currency', { currency: 'ETH' }],
  ['negative balance', { nativeBalance: '-0.01' }],
  ['balance precision', { nativeBalance: '0.0000000001' }],
  ['overflow balance', { nativeBalance: '18446744073.709551616' }],
  ['numeric slot', { block: 100 }],
  ['unsafe slot', { block: '9999999999999999' }],
  ['unexpected Solana block hash', { blockHash: 'not-admitted' }],
  ['unsafe source', { source: 'https://provider.test/key' }],
  ['invalid date', { observedAt: 'yesterday' }],
  ['over-count', { sampleCount: 51 }],
  ['successful over-count', { successfulSampleCount: 3 }],
  ['missing latest', { latestObservedAt: undefined }],
  ['reversed dates', { oldestObservedAt: '2026-10-23T11:59:30.000Z' }],
  ['future date', { latestObservedAt: '2026-10-23T12:02:00.000Z' }],
])('refuses %s without publishing partial observations', (_name, change) => {
  const value = packet();
  Object.assign(value.results[0].observation, change);
  expect(() => decodeWarmupHistory(value, 'Solana', [wallet])).toThrow();
});
it('refuses incomplete, reordered or ambiguous rows', () => {
  for (const results of [
    [],
    [{ ...packet().results[0], address: 'different' }],
    [{ ...packet().results[0], error: 'secret' }],
  ])
    expect(() =>
      decodeWarmupHistory({ chain: 'Solana', results }, 'Solana', [wallet]),
    ).toThrow();
});
it('does not expose arbitrary provider row errors', () => {
  const value = decodeWarmupHistory(
    {
      chain: 'Solana',
      results: [{ address: wallet, error: 'https://secret.test/key' }],
    },
    'Solana',
    [wallet],
  );
  expect(JSON.stringify(value)).not.toContain('secret');
  expect(value[0].error).toContain('No readiness conclusion');
});
it('strips unknown observation fields rather than retaining them in state', () => {
  const value = packet();
  Object.assign(value.results[0].observation, { privateDebug: 'not-admitted' });
  expect(
    JSON.stringify(decodeWarmupHistory(value, 'Solana', [wallet])),
  ).not.toContain('not-admitted');
});
it('rejects a wrong root chain, extra rows and reversed multi-wallet rows', () => {
  const value = packet(),
    address = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const second = {
    ...value.results[0],
    address,
    observation: { ...value.results[0].observation, address },
  };
  expect(() =>
    decodeWarmupHistory({ ...value, chain: 'Base' }, 'Solana', [wallet]),
  ).toThrow();
  expect(() =>
    decodeWarmupHistory(
      { ...value, results: [value.results[0], second] },
      'Solana',
      [wallet],
    ),
  ).toThrow();
  expect(() =>
    decodeWarmupHistory(
      { ...value, results: [second, value.results[0]] },
      'Solana',
      [wallet, address],
    ),
  ).toThrow();
});
it.each(['html', 'malformed', 'oversize'])(
  'refuses %s response bodies without partial results',
  async (mode) => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          mode === 'html'
            ? '<html>private diagnostics</html>'
            : mode === 'malformed'
              ? '{'
              : JSON.stringify({ padding: 'x'.repeat(1048576) }),
          {
            headers: {
              'content-type':
                mode === 'html' ? 'text/html' : 'application/json',
            },
          },
        ),
    );
    await expect(
      readWarmupHistory(
        'Solana',
        [wallet],
        [{ address: wallet, revision: 1 }],
        new AbortController().signal,
        fetcher,
      ),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
it('retains EVM nonce-only coverage with exact native units and canonical block', () => {
  const address = '0x0000000000000000000000000000000000000001';
  const row = {
    ...packet().results[0].observation,
    address,
    chain: 'Base',
    currency: 'ETH',
    blockHash: `0x${'ab'.repeat(32)}`,
    outgoingTransactions: '7',
    sampleCount: null,
    successfulSampleCount: null,
    oldestObservedAt: null,
    latestObservedAt: null,
  };
  expect(
    decodeWarmupHistory(
      { chain: 'Base', results: [{ address, observation: row }] },
      'Base',
      [address],
    )[0].observation?.outgoingTransactions,
  ).toBe('7');
  expect(() =>
    decodeWarmupHistory(
      {
        chain: 'Base',
        results: [{ address, observation: { ...row, blockHash: undefined } }],
      },
      'Base',
      [address],
    ),
  ).toThrow();
});
it.each([401, 404, 409, 429, 503, 502])(
  'sanitizes HTTP %s without reading private error text or retrying',
  async (status) => {
    const cancel = vi.fn();
    const fetcher = vi.fn(
      async () => new Response(new ReadableStream({ cancel }), { status }),
    );
    await expect(
      readWarmupHistory(
        'Solana',
        [wallet],
        [{ address: wallet, revision: 1 }],
        new AbortController().signal,
        fetcher,
      ),
    ).rejects.toMatchObject({ status });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
it('owns the original selection across await and sends only the existing read payload', async () => {
  const addresses = [wallet];
  let finish!: (value: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const reading = readWarmupHistory(
    'Solana',
    addresses,
    [{ address: wallet, revision: 1 }],
    new AbortController().signal,
    fetcher,
  );
  addresses[0] = 'changed';
  finish(Response.json(packet()));
  expect((await reading)[0].address).toBe(wallet);
  expect(fetcher.mock.calls[0]).toEqual([
    '/api/wallet-workspace/warmup',
    expect.objectContaining({
      cache: 'no-store',
      redirect: 'error',
      body: JSON.stringify({ chain: 'Solana', addresses: [wallet] }),
    }),
  ]);
});
it('refuses missing revisions before network activity', async () => {
  const fetcher = vi.fn();
  await expect(
    readWarmupHistory(
      'Solana',
      [wallet],
      [],
      new AbortController().signal,
      fetcher,
    ),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it('cancels a late response even if transport ignores the abort signal', async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController(),
    cancel = vi.fn();
  const reading = readWarmupHistory(
    'Solana',
    [wallet],
    [{ address: wallet, revision: 1 }],
    controller.signal,
    fetcher,
  );
  controller.abort();
  finish(new Response(new ReadableStream({ cancel })));
  await expect(reading).rejects.toThrow();
  expect(cancel).toHaveBeenCalledOnce();
});
