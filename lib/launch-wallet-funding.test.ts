import { expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import {
  launchFundingComparison,
  launchFundingRoster,
  launchFundingSelection,
  readLaunchFundingTimes,
} from './launch-wallet-funding';
import {
  walletFundingTimes,
  compareFundingEventTimes,
  type WalletFundingSelection,
} from './wallet-funding-time';
import { fundingOriginBatch } from './wallet-funding-origin-view';
import { FundingOriginClientError } from './wallet-funding-origin-client';
import { largeLayerReviewFixture } from '../test/launch-layer-review-fixture';

const address = (i: number) =>
  bs58.encode(
    Uint8Array.from({ length: 32 }, (_, j) =>
      j === 0 ? i % 256 : j === 1 ? Math.floor(i / 256) : 5,
    ),
  );
const roster = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ address: address(i), revision: 1 }));
const signature = bs58.encode(new Uint8Array(64).fill(7));
const saved = (wallets: WalletFundingSelection, known = false) =>
  walletFundingTimes.parse({
    format: 'wallet-funding-times-v1',
    network: 'mainnet',
    scope: 'most-recently-saved-native-transfer',
    capturedAt: '2026-10-23T00:00:00.000Z',
    executionAllowed: false,
    wallets: wallets.map((w) => ({
      ...w,
      funding: known ? { signature, blockTime: 1700000000, slot: 100 } : null,
      reason: known ? null : 'no-retained-receipt',
    })),
  });
const provider = (wallets: WalletFundingSelection) =>
  fundingOriginBatch.parse({
    format: 'wallet-funding-origins-v1',
    network: 'mainnet',
    scope: 'oldest-provider-reported-transaction',
    ledgerMetadata: 'provider-reported',
    historyComplete: false,
    signingAllowed: false,
    executionAllowed: false,
    context: wallets,
    capturedAt: '2026-10-23T00:00:00.000Z',
    wallets: wallets.map((w) => ({
      ...w,
      funding: null,
      reason: 'no-returned-history',
    })),
  });

it('extracts every launch role in order without modifying the envelope', async () => {
  const envelope = await largeLayerReviewFixture();
  const before = JSON.stringify(envelope);
  const result = launchFundingRoster(envelope),
    r = envelope.terms.roles;
  expect(result.wallets.map((w) => w.address)).toEqual(
    [
      r.funder,
      ...(r.developer ? [r.developer] : []),
      ...r.front,
      ...r.back,
      ...r.temporary,
      ...r.holders,
    ].map((w) => w.wallet.address),
  );
  expect(result.key).toBe(JSON.stringify(envelope));
  expect(JSON.stringify(envelope)).toBe(before);
});
it.each([0, 501])('refuses an unsupported roster size %s', (n) =>
  expect(() => launchFundingSelection(roster(n))).toThrow(),
);
it('refuses duplicate or changed references across batch boundaries', () => {
  const wallets = roster(101);
  wallets[100] = { ...wallets[0] };
  expect(() => launchFundingSelection(wallets)).toThrow(/duplicated/);
  expect(() =>
    launchFundingSelection([{ address: address(1), revision: 0 }]),
  ).toThrow();
});
it.each([1, 100, 101, 500])(
  'reads all %s saved wallets in unchanged <=100-wallet requests',
  async (n) => {
    const wallets = roster(n),
      readSizes: number[] = [];
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(init!.body as string);
        readSizes.push(request.wallets.length);
        expect(init!.method).toBe('POST');
        expect(init!.cache).toBe('no-store');
        expect(_url).toBe('/api/wallet-workspace/funding-times');
        return Response.json(saved(request.wallets));
      },
    );
    const progress = vi.fn();
    const result = await readLaunchFundingTimes(
      wallets,
      'saved',
      new AbortController().signal,
      progress,
      { fetcher },
    );
    expect(readSizes).toEqual(
      n <= 100 ? [n] : n === 101 ? [100, 1] : [100, 100, 100, 100, 100],
    );
    expect(result.observations.map((w) => w.address)).toEqual(
      wallets.map((w) => w.address),
    );
    expect(result.pairs).toEqual([]);
    expect(result.signingAllowed).toBe(false);
    expect(result.executionAllowed).toBe(false);
    expect(progress).toHaveBeenLastCalledWith({
      completed: n,
      total: n,
      phase: 'complete',
    });
  },
);
it('compares a close pair across the 100-wallet response boundary', () => {
  const wallets = roster(101),
    first = saved(wallets.slice(0, 100)),
    second = saved(wallets.slice(100));
  first.wallets[99] = {
    ...first.wallets[99],
    funding: { signature, slot: 100, blockTime: 1700000000 },
    reason: null,
  };
  second.wallets[0] = {
    ...second.wallets[0],
    funding: { signature, slot: 101, blockTime: 1700001474 },
    reason: null,
  };
  expect(
    launchFundingComparison(wallets, 'saved', [first, second]).pairs,
  ).toEqual([
    { a: wallets[99].address, b: wallets[100].address, seconds: 1474 },
  ]);
});
it('supports all 124750 close pairs at 500 while preserving the old 100-wallet default', () => {
  const wallets = roster(500),
    batches = Array.from({ length: 5 }, (_, i) =>
      saved(wallets.slice(i * 100, i * 100 + 100), true),
    );
  expect(launchFundingComparison(wallets, 'saved', batches).pairs).toHaveLength(
    124750,
  );
  expect(() =>
    compareFundingEventTimes(batches.flatMap((b) => b.wallets)),
  ).toThrow();
});
it.each(['missing', 'reordered', 'revision', 'mixed-source'] as const)(
  'refuses %s batches without keeping a partial comparison',
  (kind) => {
    const wallets = roster(101),
      batches = [saved(wallets.slice(0, 100)), saved(wallets.slice(100))];
    if (kind === 'missing') batches.pop();
    if (kind === 'reordered') batches.reverse();
    if (kind === 'revision') batches[1].wallets[0].revision++;
    if (kind === 'mixed-source')
      Object.assign(batches[1], { format: 'wallet-funding-origins-v1' });
    expect(() => launchFundingComparison(wallets, 'saved', batches)).toThrow();
  },
);
it.each([429, 503])(
  'stops on the first %s without retrying or returning prior batches',
  async (status) => {
    const wallets = roster(201);
    const fetcher = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) =>
      fetcher.mock.calls.length === 1
        ? Response.json(saved(JSON.parse(init!.body as string).wallets))
        : new Response('PRIVATE-DETAIL', { status }),
    );
    await expect(
      readLaunchFundingTimes(
        wallets,
        'saved',
        new AbortController().signal,
        () => {},
        { fetcher },
      ),
    ).rejects.toThrow(/100 of 201.*No partial result/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);
it('owns the captured roster and refuses late results after cancellation', async () => {
  const wallets = roster(1),
    original = structuredClone(wallets),
    controller = new AbortController();
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  const reading = readLaunchFundingTimes(
    wallets,
    'saved',
    controller.signal,
    () => {},
    { fetcher },
  );
  wallets[0].revision++;
  controller.abort(Error('cancelled'));
  resolve(Response.json(saved(original)));
  await expect(reading).rejects.toThrow('cancelled');
  expect(fetcher).toHaveBeenCalledOnce();
});
it('keeps the provider 100-wallet context and waits between successive contexts', async () => {
  const wallets = roster(201),
    read = vi.fn(
      async (
        selection: WalletFundingSelection,
        _s: AbortSignal,
        progress: (p: {
          completed: number;
          total: number;
          phase: 'complete';
        }) => void,
      ) => {
        progress({
          completed: selection.length,
          total: selection.length,
          phase: 'complete',
        });
        return provider(selection);
      },
    );
  const sleep = vi.fn(
      async (_milliseconds: number, _signal: AbortSignal) => {},
    ),
    progress = vi.fn();
  const result = await readLaunchFundingTimes(
    wallets,
    'provider',
    new AbortController().signal,
    progress,
    { provider: read, sleep },
  );
  expect(read.mock.calls.map((c) => c[0].length)).toEqual([100, 100, 1]);
  expect(sleep.mock.calls.map((c) => c[0])).toEqual([17000, 17000]);
  expect(result.observations).toHaveLength(201);
  expect(
    progress.mock.calls.filter((c) => c[0].phase === 'complete'),
  ).toHaveLength(1);
});
it('stops a rate-limited provider campaign with its verified global progress', async () => {
  const progress = vi.fn();
  const read = vi.fn(
    async (
      _w: WalletFundingSelection,
      _s: AbortSignal,
      p: (p: { completed: number; total: number; phase: 'reading' }) => void,
    ) => {
      p({ completed: 10, total: 100, phase: 'reading' });
      throw new FundingOriginClientError(429, 10, 100);
    },
  );
  await expect(
    readLaunchFundingTimes(
      roster(201),
      'provider',
      new AbortController().signal,
      progress,
      { provider: read },
    ),
  ).rejects.toThrow(/10 of 201.*rate limited/);
  expect(read).toHaveBeenCalledOnce();
});

it.each([
  [401, 'Sign in'],
  [409, 'references changed'],
  [503, 'storage is unavailable'],
  [408, 'timed out'],
])(
  'keeps actionable saved-read status %s without leaking response details',
  async (status, reason) => {
    const fetcher = vi.fn(
      async () => new Response('PRIVATE-DETAIL', { status: Number(status) }),
    );
    const error = await readLaunchFundingTimes(
      roster(1),
      'saved',
      new AbortController().signal,
      () => {},
      { fetcher },
    ).catch((error) => error);
    expect(error.message).toContain(String(reason));
    expect(error.message).not.toContain('PRIVATE');
    expect(error.status).toBe(status);
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
it.each([
  [401, 'Sign in'],
  [409, 'references changed'],
  [503, 'Saved receipts'],
  [408, 'timed out'],
])(
  'keeps actionable provider status %s and global coverage',
  async (status, reason) => {
    const read = vi.fn(async () => {
      throw new FundingOriginClientError(Number(status));
    });
    const error = await readLaunchFundingTimes(
      roster(101),
      'provider',
      new AbortController().signal,
      () => {},
      { provider: read },
    ).catch((error) => error);
    expect(error.message).toContain(String(reason));
    expect(error.message).toContain('0 of 101');
    expect(error.status).toBe(status);
    expect(read).toHaveBeenCalledOnce();
  },
);
it('treats an outer deadline as a timeout without starting another read', async () => {
  const timed = new AbortController();
  timed.abort(new DOMException('timeout', 'TimeoutError'));
  const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValueOnce(timed.signal),
    fetcher = vi.fn();
  try {
    await expect(
      readLaunchFundingTimes(
        roster(1),
        'saved',
        new AbortController().signal,
        () => {},
        { fetcher },
      ),
    ).rejects.toThrow(/timed out/);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    timeout.mockRestore();
  }
});

it('keeps per-request TimeoutError distinct from a generic saved-history failure', async () => {
  const fetcher = vi.fn(async () => {
    throw new DOMException('PRIVATE-DETAIL', 'TimeoutError');
  });
  const error = await readLaunchFundingTimes(
    roster(1),
    'saved',
    new AbortController().signal,
    () => {},
    { fetcher },
  ).catch((error) => error);
  expect(error.status).toBe(408);
  expect(error.message).toContain('timed out');
  expect(error.message).not.toContain('PRIVATE');
  expect(fetcher).toHaveBeenCalledOnce();
});
