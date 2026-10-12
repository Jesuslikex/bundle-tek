import { afterEach, expect, it, vi } from 'vitest';
import { env } from '../test/cloudflare-workers';
import { balanceRpc } from './wallet-balances';
afterEach(() => {
  delete (env as Record<string, unknown>).SOLANA_RPC_MIN_INTERVAL_MS;
  vi.useRealTimers();
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
