import { afterEach, expect, it, vi } from 'vitest';
import { env } from '../test/cloudflare-workers';
import { balanceRpc } from './wallet-balances';
import {
  paceWalletRpc,
  stockQualificationMethodBudget,
} from './wallet-rpc-pacing';
afterEach(() => {
  delete (env as Record<string, unknown>).SOLANA_RPC_MIN_INTERVAL_MS;
  vi.useRealTimers();
});

it('uses the unchanged nine-method scheduler on an explicitly scoped standard validator without pacing ordinary calls', async () => {
  vi.useFakeTimers();
  const endpoint = 'https://validator.example.test/stock-qualified';
  const signal = new AbortController().signal;
  await expect(paceWalletRpc(endpoint, signal, 1)).rejects.toThrow('profile');
  const admitted: number[] = [];
  const reads = Array.from({ length: 12 }, () =>
    paceWalletRpc(endpoint, signal, 1, 'stock-runtime-evidence').then(() =>
      admitted.push(Date.now()),
    ),
  );
  await vi.advanceTimersByTimeAsync(2000);
  await Promise.all(reads);
  for (const time of admitted)
    expect(
      admitted.filter((t) => t <= time && t > time - 1000).length,
    ).toBeLessThanOrEqual(9);
  const start = Date.now();
  await paceWalletRpc(endpoint, signal);
  expect(Date.now()).toBe(start);
});
it('does not apply the Solana provider interval to EVM reads', async () => {
  vi.useFakeTimers();
  (env as Record<string, unknown>).SOLANA_RPC_MIN_INTERVAL_MS = '1100';
  const sends: number[] = [];
  const fetcher = vi.fn(async () => {
    sends.push(Date.now());
    return Response.json({ jsonrpc: '2.0', id: 1, result: '0x1' });
  });
  await expect(
    Promise.all(
      ['eth_chainId', 'eth_getBalance'].map((method) =>
        balanceRpc(
          'https://evm-paced-test.example',
          method,
          [],
          AbortSignal.timeout(1000),
          fetcher as typeof fetch,
        ),
      ),
    ),
  ).resolves.toEqual(['0x1', '0x1']);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(sends[1] - sends[0]).toBe(0);
});
it('spaces concurrent provider requests and aborts a queued read without sending or retrying it', async () => {
  vi.useFakeTimers();
  (env as Record<string, unknown>).SOLANA_RPC_MIN_INTERVAL_MS = '1100';
  const sends: number[] = [];
  const fetcher = vi.fn(async () => {
    sends.push(Date.now());
    return Response.json({ jsonrpc: '2.0', id: 1, result: 'ok' });
  });
  const controller = new AbortController();
  const read = () =>
    balanceRpc(
      'https://paced-test.example',
      'getGenesisHash',
      [],
      AbortSignal.timeout(10000),
      fetcher as typeof fetch,
    );
  const first = read(),
    second = read();
  const queued = balanceRpc(
    'https://paced-test.example',
    'getGenesisHash',
    [],
    controller.signal,
    fetcher as typeof fetch,
  );
  const rejected = expect(queued).rejects.toThrow('cancelled');
  controller.abort(new Error('cancelled'));
  await rejected;
  await vi.advanceTimersByTimeAsync(1100);
  await expect(first).resolves.toBe('ok');
  await expect(second).resolves.toBe('ok');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(sends[1] - sends[0]).toBe(1100);
});
it('rejects invalid pacing before sending a provider request', async () => {
  const fetcher = vi.fn();
  for (const value of ['-1', '2001', '1.5', '100000', 'x']) {
    (env as Record<string, unknown>).SOLANA_RPC_MIN_INTERVAL_MS = value;
    await expect(
      balanceRpc(
        'https://invalid-paced-test.example',
        'getGenesisHash',
        [],
        AbortSignal.timeout(1000),
        fetcher,
      ),
    ).rejects.toThrow('pacing');
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it('counts actual single and double qualification admissions under nine methods in every rolling second', async () => {
  vi.useFakeTimers();
  (env as Record<string, unknown>).SOLANA_RPC_MIN_INTERVAL_MS = '200';
  const endpoint = 'https://mainnet.helius-rpc.com/qualification-mixed';
  const sent: { at: number; units: number }[] = [];
  const pending = [1, 2, 1, 2, 2, 1, 2, 1, 2, 2, 1, 2].map(async (units) => {
    await paceWalletRpc(endpoint, new AbortController().signal, units);
    sent.push({ at: Date.now(), units });
  });
  await vi.runAllTimersAsync();
  await Promise.all(pending);
  expect(sent).toHaveLength(12);
  for (const item of sent) {
    expect(
      sent
        .filter((entry) => entry.at <= item.at && entry.at > item.at - 1000)
        .reduce((sum, entry) => sum + entry.units, 0),
    ).toBeLessThanOrEqual(9);
  }
  expect(sent[1].at - sent[0].at).toBe(112);
  expect(sent[2].at - sent[1].at).toBe(224);
});
it('rechecks admission time after delayed timers and never sends a cancelled qualification read', async () => {
  vi.useFakeTimers();
  (env as Record<string, unknown>).SOLANA_RPC_MIN_INTERVAL_MS = '200';
  const endpoint = 'https://mainnet.helius-rpc.com/qualification-delayed';
  const signal = new AbortController().signal;
  await paceWalletRpc(endpoint, signal, 2);
  const cancelled = new AbortController();
  const rejected = expect(
    paceWalletRpc(endpoint, cancelled.signal, 2),
  ).rejects.toThrow('cancelled');
  cancelled.abort(new Error('cancelled'));
  await vi.runAllTimersAsync();
  await rejected;
  const pending = paceWalletRpc(endpoint, signal, 1);
  vi.setSystemTime(Date.now() + 5000);
  await vi.runAllTimersAsync();
  await pending;
  const at = Date.now();
  const next = paceWalletRpc(endpoint, signal, 1);
  await vi.advanceTimersByTimeAsync(111);
  let done = false;
  void next.then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await next;
  expect(Date.now() - at).toBe(112);
});
it('rejects an unsupported qualification provider or invalid method count', async () => {
  for (const [endpoint, units] of [
    ['https://example.test', 1],
    ['https://mainnet.helius-rpc.com/invalid', 0],
    ['https://mainnet.helius-rpc.com/invalid', 3],
  ] as const) {
    await expect(
      paceWalletRpc(endpoint, new AbortController().signal, units),
    ).rejects.toThrow('qualification');
  }
});

it('does not enroll ordinary reads in an existing qualification profile without configured pacing', async () => {
  vi.useFakeTimers();
  const endpoint = 'https://mainnet.helius-rpc.com/isolated-unconfigured';
  const signal = new AbortController().signal;
  await paceWalletRpc(endpoint, signal, 2);
  const at = Date.now();
  await Promise.all(
    Array.from({ length: 12 }, () => paceWalletRpc(endpoint, signal)),
  );
  expect(Date.now()).toBe(at);
  let admitted = false;
  const qualified = paceWalletRpc(endpoint, signal, 1).then(() => {
    admitted = true;
  });
  await vi.advanceTimersByTimeAsync(223);
  expect(admitted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await qualified;
});

it('keeps configured and qualification schedules independent on the same endpoint', async () => {
  vi.useFakeTimers();
  (env as Record<string, unknown>).SOLANA_RPC_MIN_INTERVAL_MS = '300';
  const endpoint = 'https://mainnet.helius-rpc.com/isolated-configured';
  const signal = new AbortController().signal;
  await paceWalletRpc(endpoint, signal, 2);
  const at = Date.now();
  await paceWalletRpc(endpoint, signal);
  expect(Date.now()).toBe(at);
  const ordinaryTimes: number[] = [],
    qualificationTimes: number[] = [];
  const ordinary = Promise.all(
    [1, 2, 3].map(async () => {
      await paceWalletRpc(endpoint, signal);
      ordinaryTimes.push(Date.now() - at);
    }),
  );
  const qualified = paceWalletRpc(endpoint, signal, 1).then(() => {
    qualificationTimes.push(Date.now() - at);
  });
  await vi.runAllTimersAsync();
  await Promise.all([ordinary, qualified]);
  expect(ordinaryTimes).toEqual([300, 600, 900]);
  expect(qualificationTimes).toEqual([300]);
});
it('raises the qualification budget only for the configured stock runtime endpoint', async () => {
  const runtime = 'https://solana-mainnet.example.test/v2/fixture';
  expect(stockQualificationMethodBudget(runtime, undefined, runtime)).toBe(9);
  expect(stockQualificationMethodBudget(runtime, '25', runtime)).toBe(25);
  expect(
    stockQualificationMethodBudget(
      'https://indexer.example.test/',
      '25',
      runtime,
    ),
  ).toBe(9);
  expect(stockQualificationMethodBudget(runtime, '25', '')).toBe(9);
  for (const bad of ['0', '100', '9.5', ' 25', 'many'])
    expect(() => stockQualificationMethodBudget(runtime, bad, runtime)).toThrow(
      'Invalid stock runtime RPC method budget.',
    );
  vi.useFakeTimers();
  (env as Record<string, unknown>).SOLANA_STOCK_RUNTIME_METHODS_PER_SECOND =
    '25';
  (env as Record<string, unknown>).SOLANA_STOCK_RUNTIME_RPC_URL = runtime;
  try {
    const signal = new AbortController().signal;
    const admitted: number[] = [];
    const reads = Array.from({ length: 60 }, () =>
      paceWalletRpc(runtime, signal, 1, 'stock-runtime-evidence').then(() =>
        admitted.push(Date.now()),
      ),
    );
    await vi.advanceTimersByTimeAsync(4000);
    await Promise.all(reads);
    const peak = Math.max(
      ...admitted.map(
        (time) => admitted.filter((t) => t <= time && t > time - 1000).length,
      ),
    );
    expect(peak).toBeLessThanOrEqual(25);
    expect(peak).toBeGreaterThan(9);
  } finally {
    delete (env as Record<string, unknown>)
      .SOLANA_STOCK_RUNTIME_METHODS_PER_SECOND;
    delete (env as Record<string, unknown>).SOLANA_STOCK_RUNTIME_RPC_URL;
  }
});
