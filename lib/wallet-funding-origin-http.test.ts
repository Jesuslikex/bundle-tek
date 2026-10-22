import { afterEach, expect, it, vi } from 'vitest';
import { env } from '@/lib/server-env';
import { fundingOriginApiFixture } from '../test/wallet-funding-origin-api-fixture';
import { readOwnedFundingOrigins } from './wallet-funding-origin-server';
import { fundingOriginRpc } from './wallet-funding-origin-rpc';
import { paceWalletRpc } from './wallet-rpc-pacing';
const clients: ReturnType<typeof fundingOriginApiFixture>[] = [];
let counter = 0;
const fixture = (n = 1) => {
  const f = fundingOriginApiFixture(n);
  clients.push(f);
  f.endpoint += '/case-' + counter++;
  return f;
};
afterEach(() => {
  clients.splice(0).forEach((f) => f.close());
  delete env.SOLANA_RPC_MIN_INTERVAL_MS;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const signal = () => new AbortController().signal;
it('composes the real bounded lossless HTTP transport and full native decoder', async () => {
  env.SOLANA_RPC_MIN_INTERVAL_MS = '0';
  const f = fixture();
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    expect(_url).toBe(f.endpoint);
    expect(init.redirect).toBe('error');
    const body = JSON.parse(init.body as string);
    const result = await f.rpc(body.method, body.params);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  const result = await readOwnedFundingOrigins(
    f.db,
    'owner',
    { wallets: f.wallets, context: f.wallets },
    signal(),
    { endpoint: f.endpoint },
  );
  expect(result.wallets[0].funding?.recipientChangeRaw).toBe('10000');
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(f.calls).toEqual([
    'getGenesisHash',
    'getTransactionsForAddress',
    'getSignatureStatuses',
  ]);
});
it('fits all ten wallets at the maximum configured pacing interval with twelve RPC calls', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
  env.SOLANA_RPC_MIN_INTERVAL_MS = '2000';
  const f = fixture(10);
  const budgets: number[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    budgets.push(ms);
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException('Timeout', 'TimeoutError')),
      ms,
    );
    return controller.signal;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: await f.rpc(body.method, body.params),
      });
    }),
  );
  const pending = readOwnedFundingOrigins(
    f.db,
    'owner',
    { wallets: f.wallets, context: f.wallets },
    signal(),
    { endpoint: f.endpoint },
  );
  await vi.advanceTimersByTimeAsync(24000);
  const result = await pending;
  expect(result.wallets.every((w) => w.funding !== null)).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(12);
  expect(budgets.filter((ms) => ms === 45000)).toHaveLength(1);
  expect(budgets.filter((ms) => ms === 8000)).toHaveLength(12);
});
it('keeps queue waits outside the per-fetch timeout without changing the shared pacing implementation', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
  env.SOLANA_RPC_MIN_INTERVAL_MS = '2000';
  const f = fixture();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException('Timeout', 'TimeoutError')),
      ms,
    );
    return controller.signal;
  });
  const reserved = Array.from({ length: 6 }, () =>
    paceWalletRpc(f.endpoint, signal()),
  );
  const fetcher = vi.fn(async () =>
    Response.json({ jsonrpc: '2.0', id: 1, result: 'ok' }),
  );
  const pending = fundingOriginRpc(
    f.endpoint,
    'getGenesisHash',
    [],
    signal(),
    fetcher,
  );
  await vi.advanceTimersByTimeAsync(11999);
  expect(fetcher).not.toHaveBeenCalled();
  expect(timeout).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(timeout).toHaveBeenCalledExactlyOnceWith(8000);
  expect(await pending).toBe('ok');
  await Promise.all(reserved);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('aborts a queued request before any network work', async () => {
  vi.useFakeTimers();
  env.SOLANA_RPC_MIN_INTERVAL_MS = '2000';
  const f = fixture();
  await paceWalletRpc(f.endpoint, signal());
  const c = new AbortController();
  const fetcher = vi.fn();
  const pending = fundingOriginRpc(
    f.endpoint,
    'getGenesisHash',
    [],
    c.signal,
    fetcher,
  ).catch((e) => e);
  c.abort();
  await pending;
  await vi.advanceTimersByTimeAsync(2000);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([429, 302])(
  'maps real HTTP %s without retrying or reading private error bodies',
  async (status) => {
    env.SOLANA_RPC_MIN_INTERVAL_MS = '0';
    const f = fixture();
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel }), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    await expect(
      readOwnedFundingOrigins(
        f.db,
        'owner',
        { wallets: f.wallets, context: f.wallets },
        signal(),
        { endpoint: f.endpoint },
      ),
    ).rejects.toMatchObject({ status: status === 429 ? 429 : 502 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalled();
  },
);
it('rejects oversized or mismatched JSON-RPC bodies before another method is requested', async () => {
  env.SOLANA_RPC_MIN_INTERVAL_MS = '0';
  for (const result of [
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'private' }), {
      headers: { 'content-type': 'application/json' },
    }),
    new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'x'.repeat(524289) }),
      { headers: { 'content-type': 'application/json' } },
    ),
  ]) {
    const f = fixture();
    const fetcher = vi.fn(async () => result);
    vi.stubGlobal('fetch', fetcher);
    await expect(
      readOwnedFundingOrigins(
        f.db,
        'owner',
        { wallets: f.wallets, context: f.wallets },
        signal(),
        { endpoint: f.endpoint },
      ),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});

it('preserves native uint64 JSON literals above Number precision through the real parser', async () => {
  env.SOLANA_RPC_MIN_INTERVAL_MS = '0';
  const f = fixture();
  f.records[0].receipt.meta.preBalances[0] = '10000000000000000';
  f.records[0].receipt.meta.postBalances[0] = '9999999999985000';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const result = await f.rpc(body.method, body.params);
      const text = JSON.stringify({ jsonrpc: '2.0', id: 1, result })
        .replace(/"10000000000000000"/g, '10000000000000000')
        .replace(/"9999999999985000"/g, '9999999999985000');
      return new Response(text, {
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  const result = await readOwnedFundingOrigins(
    f.db,
    'owner',
    { wallets: f.wallets, context: f.wallets },
    signal(),
    { endpoint: f.endpoint },
  );
  expect(result.wallets[0].funding?.recipientChangeRaw).toBe('10000');
});
it('applies the fetch timeout after pacing and cancels a stalled response', async () => {
  env.SOLANA_RPC_MIN_INTERVAL_MS = '0';
  const f = fixture();
  const timeout = new AbortController();
  const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
  let entered = false;
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (!init?.signal) throw Error('Missing cancellation signal.');
    const current = init.signal;
    entered = true;
    return new Promise<Response>((_, reject) =>
      current.addEventListener('abort', () => reject(current.reason), {
        once: true,
      }),
    );
  });
  try {
    const result = fundingOriginRpc(
      f.endpoint,
      'getGenesisHash',
      [],
      signal(),
      fetcher,
    ).catch((e) => e);
    for (let i = 0; i < 20 && !entered; i++) await Promise.resolve();
    expect(entered).toBe(true);
    expect(spy).toHaveBeenCalledWith(8000);
    timeout.abort(new DOMException('Timeout', 'TimeoutError'));
    expect(await result).toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
  }
});

it('handles numeric v0 metadata through the real HTTP parser without lookup reuse', async () => {
  env.SOLANA_RPC_MIN_INTERVAL_MS = '0';
  const f = fixture();
  Object.assign(f.records[0].message, { version: 0, addressTableLookups: [] });
  f.records[0].receipt.version = '0';
  f.records[0].resign();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const input = JSON.parse(init.body as string);
      const result = await f.rpc(input.method, input.params);
      const numeric = JSON.parse(JSON.stringify(result), (_k, v) =>
        typeof v === 'string' && /^(0|[1-9]\d{0,15})$/.test(v) ? Number(v) : v,
      );
      return Response.json({ jsonrpc: '2.0', id: 1, result: numeric });
    }),
  );
  const result = await readOwnedFundingOrigins(
    f.db,
    'owner',
    { wallets: f.wallets, context: f.wallets },
    signal(),
    { endpoint: f.endpoint },
  );
  expect(result.wallets[0].funding).not.toBeNull();
});

it('rejects a string response id for its numeric request id', async () => {
  env.SOLANA_RPC_MIN_INTERVAL_MS = '0';
  const f = fixture();
  await expect(
    fundingOriginRpc(f.endpoint, 'getGenesisHash', [], signal(), async () =>
      Response.json({ jsonrpc: '2.0', id: '1', result: 'ok' }),
    ),
  ).rejects.toThrow('Funding history response unavailable');
});
