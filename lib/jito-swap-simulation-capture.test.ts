import { expect, it, vi, afterEach } from 'vitest';
import { nativeWarmupFixture } from '../test/warmup-native-fixture';
import {
  captureJitoSwapSimulation,
  replayJitoSwapSimulation,
} from './jito-swap-simulation-capture';
import { snapshotJitoEvidence } from './jito-evidence-json';
import * as pacing from './wallet-rpc-pacing';
import { getSolanaIndexerRpcEndpoint } from './solana-rpc';
import { env } from '@/lib/server-env';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete (env as Record<string, unknown>).SOLANA_RPC_MIN_INTERVAL_MS;
  vi.useRealTimers();
});
it('paces acquisition but never waits on or mutates the live pacing queue during retained replay', async () => {
  const f = await nativeWarmupFixture({ lookup: true });
  const pace = vi.spyOn(pacing, 'paceWalletRpc').mockResolvedValue();
  const captured = await captureJitoSwapSimulation(
    f.order,
    new AbortController().signal,
    f.fetcher as typeof fetch,
  );
  expect(pace.mock.calls.length).toBe(captured.reads.length);
  pace.mockClear();
  const reproduced = await replayJitoSwapSimulation(
    captured,
    new AbortController().signal,
  );
  expect(reproduced.simulation).toEqual(captured.simulation);
  expect(pace).not.toHaveBeenCalled();
});
it('replays without advancing real pacing timers or consuming another endpoint queue position', async () => {
  const f = await nativeWarmupFixture({ lookup: true });
  const pace = vi.spyOn(pacing, 'paceWalletRpc').mockResolvedValue();
  const captured = await captureJitoSwapSimulation(
    f.order,
    new AbortController().signal,
    f.fetcher as typeof fetch,
  );
  pace.mockRestore();
  (env as Record<string, unknown>).SOLANA_RPC_MIN_INTERVAL_MS = '2000';
  vi.useFakeTimers();
  const timers = vi.spyOn(globalThis, 'setTimeout');
  const endpoint = getSolanaIndexerRpcEndpoint(),
    c = new AbortController();
  await pacing.paceWalletRpc(endpoint, c.signal);
  const waiting = pacing.paceWalletRpc(endpoint, c.signal);
  const settled = Promise.allSettled([waiting]);
  expect(vi.getTimerCount()).toBe(1);
  expect(timers.mock.calls.at(-1)?.[1]).toBe(2000);
  const reproduced = await replayJitoSwapSimulation(captured, c.signal);
  expect(reproduced.simulation).toEqual(captured.simulation);
  expect(vi.getTimerCount()).toBe(1);
  const later = pacing.paceWalletRpc(endpoint, c.signal);
  const laterSettled = Promise.allSettled([later]);
  expect(vi.getTimerCount()).toBe(2);
  expect(timers.mock.calls.at(-1)?.[1]).toBe(4000);
  c.abort();
  await Promise.all([settled, laterSettled]);
  expect(vi.getTimerCount()).toBe(0);
});
for (const side of ['Buy', 'Sell'] as const)
  for (const lookup of [false, true])
    it(`captures and replays full ${side}/ALT=${lookup} using original decoders`, async () => {
      const f = await nativeWarmupFixture({ side, lookup });
      const network = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(Error('network forbidden'));
      const captured = await captureJitoSwapSimulation(
        f.order,
        new AbortController().signal,
        f.fetcher as typeof fetch,
      );
      expect(captured.simulation.settlementEvidence).not.toBeNull();
      expect(
        captured.reads.some(
          (r) => JSON.parse(r.requestBody).method === 'simulateTransaction',
        ),
      ).toBe(true);
      const replay = await replayJitoSwapSimulation(
        captured,
        new AbortController().signal,
      );
      expect(replay).toMatchObject({
        rawSimulationChecksPassed: true,
        signingAllowed: false,
        executionAllowed: false,
      });
      expect(network).not.toHaveBeenCalled();
      captured.reads[0].rawBody[0] ^= 1;
      await expect(
        replayJitoSwapSimulation(captured, new AbortController().signal),
      ).rejects.toThrow();
    });
it('refuses saved scalar summaries instead of filling missing simulation fields', async () => {
  await expect(
    replayJitoSwapSimulation({} as never, new AbortController().signal),
  ).rejects.toThrow();
});
it('stops new reads after HTTP429 and never returns a complete capture', async () => {
  const f = await nativeWarmupFixture({ side: 'Buy' });
  const fetcher = vi.fn(async () => new Response(null, { status: 429 }));
  await expect(
    captureJitoSwapSimulation(
      f.order,
      new AbortController().signal,
      fetcher as typeof fetch,
    ),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('does not invoke getters and snapshots original caller data', () => {
  let invoked = false;
  const v = {
    get value() {
      invoked = true;
      throw Error('not data');
    },
  };
  expect(() => snapshotJitoEvidence(v)).toThrow();
  expect(invoked).toBe(false);
  const sparse = [1, 2];
  Reflect.deleteProperty(sparse, '0');
  for (const value of [NaN, Infinity, -0, sparse, { value: undefined }])
    expect(() => snapshotJitoEvidence(value)).toThrow();
  const a = { x: [1, 'a'] },
    b = snapshotJitoEvidence(a);
  a.x[0] = 9;
  expect(b.x[0]).toBe(1);
});

it('owns and cancels a late response after capture cancellation', async () => {
  const f = await nativeWarmupFixture();
  const c = new AbortController();
  let release!: (r: Response) => void;
  const cancelled = vi.fn();
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((r) => {
        release = r;
      }),
  );
  const pending = captureJitoSwapSimulation(
    f.order,
    c.signal,
    fetcher as typeof fetch,
  );
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  c.abort();
  await expect(pending).rejects.toThrow();
  release(new Response(new ReadableStream({ cancel: cancelled })));
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
  expect(fetcher).toHaveBeenCalledTimes(1);
});
