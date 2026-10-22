import { afterEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import {
  decodeBubbleMapResponse,
  readBubbleMapFunding,
} from './bubble-map-client';
const addresses = Array.from({ length: 32 }, (_, i) =>
  bs58.encode(new Uint8Array(32).fill(i + 1)),
);
const result = (selection = addresses) => ({
  network: 'mainnet',
  funders: Object.fromEntries(
    selection.map((a) => [a, { funder: null, reason: 'history-unavailable' }]),
  ),
});
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('waits a full gate after the response before requesting the remaining wallets', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async (_: string, init: RequestInit) =>
    Response.json(result(JSON.parse(init.body as string).addresses)),
  );
  vi.stubGlobal('fetch', fetchMock);
  const progress = vi.fn();
  const pending = readBubbleMapFunding(
    addresses,
    new AbortController().signal,
    progress,
  );
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(progress).toHaveBeenLastCalledWith(
    expect.objectContaining({ completed: 20, phase: 'waiting' }),
  );
  await vi.advanceTimersByTimeAsync(9999);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(Object.keys(await pending)).toEqual(addresses);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(progress).toHaveBeenLastCalledWith({
    completed: 32,
    total: 32,
    group: 2,
    groups: 2,
    phase: 'complete',
  });
});
it('aborts the gate timer without requesting another group', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async (_: string, init: RequestInit) =>
    Response.json(result(JSON.parse(init.body as string).addresses)),
  );
  vi.stubGlobal('fetch', fetchMock);
  const controller = new AbortController();
  const progress = vi.fn();
  const pending = readBubbleMapFunding(
    addresses,
    controller.signal,
    progress,
  ).catch((e) => e);
  await flush();
  expect(progress).toHaveBeenLastCalledWith(
    expect.objectContaining({ phase: 'waiting' }),
  );
  controller.abort();
  await pending;
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it.each([429, 502])(
  'stops on HTTP %s without retry or leaking provider HTML',
  async (status) => {
    const fetchMock = vi.fn(
      async () =>
        new Response('<html>private-provider-text</html>', { status }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      readBubbleMapFunding(addresses, new AbortController().signal, () => {}),
    ).rejects.toThrow(status === 429 ? 'cooling down' : 'could not be checked');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);
it('admits exactly the requested response and rejects unsupported evidence shapes', () => {
  const a = addresses[0];
  const good = result([a]);
  expect(decodeBubbleMapResponse(good, [a])).toEqual(good.funders);
  for (const value of [
    { ...good, network: 'devnet' },
    { ...good, executionAllowed: true },
    result(addresses.slice(0, 2)),
    { network: 'mainnet', funders: {} },
    { network: 'mainnet', funders: { [a]: { funder: null } } },
    {
      network: 'mainnet',
      funders: {
        [a]: {
          funder: { funder: addresses[1], signature: 'invalid', slot: 1 },
        },
      },
    },
  ])
    expect(() => decodeBubbleMapResponse(value, [a])).toThrow();
});
it('rejects malformed JSON before starting a later group', async () => {
  const fetchMock = vi.fn(
    async () =>
      new Response('{private-parser-text', {
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  await expect(
    readBubbleMapFunding(addresses, new AbortController().signal, () => {}),
  ).rejects.toThrow('could not be checked');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('does not use a slow local clock to reject server-reported metadata', () => {
  vi.spyOn(Date, 'now').mockReturnValue(0);
  try {
    const a = addresses[0];
    const signature = bs58.encode(new Uint8Array(64).fill(1));
    expect(
      decodeBubbleMapResponse(
        {
          network: 'mainnet',
          funders: {
            [a]: {
              funder: {
                funder: addresses[1],
                signature,
                slot: 1,
                blockTime: 1700000000,
              },
            },
          },
        },
        [a],
      )[a].funder?.blockTime,
    ).toBe(1700000000);
  } finally {
    vi.restoreAllMocks();
  }
});
it('discloses discarded earlier reads on a second-group failure without retry', async () => {
  vi.useFakeTimers();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json(result(addresses.slice(0, 20))))
    .mockResolvedValueOnce(new Response('private', { status: 429 }));
  vi.stubGlobal('fetch', fetchMock);
  const pending = readBubbleMapFunding(
    addresses,
    new AbortController().signal,
    () => {},
  ).catch((error) => error);
  await flush();
  await vi.advanceTimersByTimeAsync(10000);
  expect((await pending).message).toContain(
    '20 of 32 wallets were read before stopping. No partial map was kept.',
  );
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('maps a request timeout to a static unavailable result without retry', async () => {
  const timeout = new AbortController();
  const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
  const fetchMock = vi.fn(
    async (_: string, init: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init.signal!.addEventListener(
          'abort',
          () => reject(init.signal!.reason),
          { once: true },
        ),
      ),
  );
  vi.stubGlobal('fetch', fetchMock);
  try {
    const pending = readBubbleMapFunding(
      addresses,
      new AbortController().signal,
      () => {},
    ).catch((error) => error);
    expect(spy).toHaveBeenCalledWith(60000);
    timeout.abort(new DOMException('private-timeout-text', 'TimeoutError'));
    expect((await pending).message).toContain('could not be checked');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
  }
});
it('refuses wrong-wallet responses and unknown reason or funder fields', () => {
  const a = addresses[0];
  expect(() => decodeBubbleMapResponse(result([addresses[1]]), [a])).toThrow();
  expect(() =>
    decodeBubbleMapResponse(
      {
        network: 'mainnet',
        funders: { [a]: { funder: null, reason: 'arbitrary' } },
      },
      [a],
    ),
  ).toThrow();
  expect(() =>
    decodeBubbleMapResponse(
      {
        network: 'mainnet',
        funders: {
          [a]: {
            funder: {
              funder: addresses[1],
              signature: bs58.encode(new Uint8Array(64).fill(1)),
              slot: 1,
              executionAllowed: true,
            },
          },
        },
      },
      [a],
    ),
  ).toThrow();
});
