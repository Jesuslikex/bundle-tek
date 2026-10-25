import { expect, it, vi, afterEach } from 'vitest';
import { nativeWarmupFixture } from '../test/warmup-native-fixture';
import {
  captureJitoSwapSimulation,
  replayJitoSwapSimulation,
} from './jito-swap-simulation-capture';
import { snapshotJitoEvidence } from './jito-evidence-json';
afterEach(() => vi.restoreAllMocks());
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
