import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import {
  captureJitoSwapSimulation,
  replayJitoSwapSimulation,
} from '../lib/jito-swap-simulation-capture';
import {
  buildJitoAssetRead,
  readJitoAssetEvidence,
} from '../lib/jito-asset-evidence';
import type { SolanaSwapPreparation } from '../lib/warmup-swap-quote';
import * as simulationModule from '../lib/imported-swap-simulation';
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const saved = JSON.parse(
  readFileSync('test/fixtures/jito-full-baseline-20261024.json', 'utf8'),
) as {
  capturedAt: string;
  order: SolanaSwapPreparation;
  reads: {
    requestBody: string;
    requestSha256: string;
    rawBody: string;
    rawSha256: string;
  }[];
  originalMinimumSlot: number;
  assetBefore: {
    requestBody: string;
    rawBody: string;
    rawSha256: string;
    slot: number;
  };
};
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
it('replays an actual complete unsigned public swap baseline through the unchanged validators offline', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(saved.capturedAt));
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(Error('network forbidden'));
  let next = 0;
  const used = new Set<number>();
  let originalRefusal: unknown;
  const simulate = simulationModule.simulateImportedSwap;
  vi.spyOn(simulationModule, 'simulateImportedSwap').mockImplementation(
    async (...args) => {
      try {
        return await simulate(...args);
      } catch (error) {
        originalRefusal = error;
        throw error;
      }
    },
  );
  const fetcher: typeof fetch = async (_url, init) => {
    // Height and fee reads start together. Asynchronous request hashing can
    // reverse their wire arrival. Match complete requests, not arrival order.
    // Only two known request options postdate this historical recording:
    // finalized height commitment and explicitly requesting the retained logs.
    if (typeof init?.body !== 'string')
      throw Error('Expected an exact JSON request body.');
    const got = JSON.parse(init.body);
    const index = saved.reads.findIndex((read, i) => {
      if (used.has(i)) return false;
      const want = JSON.parse(read.requestBody);
      if (want.method === 'getBlockHeight')
        want.params = [{ commitment: 'finalized' }];
      if (
        want.method === 'simulateTransaction' &&
        !Object.hasOwn(want.params[1], 'logs')
      ) {
        if (!Array.isArray(JSON.parse(read.rawBody).result?.value?.logs))
          return false;
        want.params[1].logs = true;
      }
      return isDeepStrictEqual(got, want);
    });
    expect(index).toBeGreaterThanOrEqual(0);
    const raw = saved.reads[index];
    used.add(index);
    next++;
    expect(hash(raw.requestBody)).toBe(raw.requestSha256);
    expect(hash(raw.rawBody)).toBe(raw.rawSha256);
    return new Response(raw.rawBody);
  };
  const result = await captureJitoSwapSimulation(
    saved.order,
    new AbortController().signal,
    fetcher,
  ).catch((error) => {
    throw originalRefusal ?? error;
  });
  expect(next).toBe(saved.reads.length);
  expect(result.simulation.settlementEvidence).not.toBeNull();
  expect(result.simulation.succeeded).toBe(true);
  expect(result.simulation.minimumOutputCovered).toBe(true);
  const replay = await replayJitoSwapSimulation(
    result,
    new AbortController().signal,
  );
  expect(replay.rawSimulationChecksPassed).toBe(true);
  expect(network).not.toHaveBeenCalled();
  expect(replay.signingAllowed).toBe(false);
});
it('admits actual independent mint/Rent bytes without inventing the unreached after-bank read', async () => {
  const request = JSON.parse(saved.assetBefore.requestBody);
  const plan = buildJitoAssetRead(
    request.params[0].slice(0, -1),
    saved.originalMinimumSlot,
    request.params[1].minContextSlot,
    request.id,
  );
  expect(plan.body).toBe(saved.assetBefore.requestBody);
  expect(hash(saved.assetBefore.rawBody)).toBe(saved.assetBefore.rawSha256);
  const captured = await readJitoAssetEvidence(
    plan,
    new Response(saved.assetBefore.rawBody).body,
    new AbortController().signal,
  );
  expect(captured.slot).toBe(saved.assetBefore.slot);
});
