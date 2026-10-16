import { afterEach, expect, it, vi } from 'vitest';
import * as pairReads from './pair-read-rpc';
import * as solanaRpc from './solana-rpc';
import { readFileSync } from 'node:fs';
import { pairRuntimeFixture } from '../test/pair-runtime-fixture';
import { PAIR_CLOCK } from './pair-mint-evidence';
import { pairQuoteClock } from '../test/imported-pair-quote-fixture';
import {
  qualifyOwnedPairOrderFirstRuntime,
  pairOrderFirstRequest,
} from './pair-order-first-service';
let fixture: Awaited<ReturnType<typeof pairRuntimeFixture>> | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  fixture?.close();
  fixture = undefined;
});
async function setup() {
  const f = (fixture = await pairRuntimeFixture());
  f.sqlite.exec(
    'CREATE TABLE imported_market_observations(owner_id TEXT,project_id TEXT,document TEXT,observed_at TEXT)',
  );
  f.sqlite.exec(
    readFileSync(
      new URL('../drizzle/0089_pair_order_first_reviews.sql', import.meta.url),
      'utf8',
    ).replaceAll('--> statement-breakpoint', ''),
  );
  const request = { ...f.orderRequest, absoluteMinimumRaw: null };
  const run = (signal = new AbortController().signal) =>
    qualifyOwnedPairOrderFirstRuntime(
      f.db,
      'alice',
      request,
      signal,
      f.runtimeDependencies,
    );
  return { f, request, run };
}
it('qualifies the exact order-first lifecycle with one simulation, fresh full code scans and no signing authority', async () => {
  const { f, run } = await setup();
  f.runtimeState.onCodeRead = () => {};
  const sequence: string[] = [],
    quote = f.quote.getMockImplementation()!,
    prepare = f.prepare.getMockImplementation()!;
  f.quote.mockImplementation(async (...args) => {
    sequence.push('quote');
    return quote(...args);
  });
  f.prepare.mockImplementation(async (...args) => {
    sequence.push('order');
    return prepare(...args);
  });
  const result = await run();
  expect(sequence).toEqual(['quote', 'order', 'quote']);
  expect(
    f.rpc.mock.calls.filter(([m]) => m === 'simulateTransaction'),
  ).toHaveLength(1);
  expect(f.runtimeState.codeReads).toBe(f.programs.size * 6);
  expect(
    result.runtime.maximumSlot - result.runtime.minimumSlot,
  ).toBeLessThanOrEqual(32);
  expect(result).toMatchObject({
    signingAllowed: false,
    executionAllowed: false,
    runtime: {
      codeIdentityObserved: true,
      trustedProgramPolicyEstablished: false,
      signingAllowed: false,
    },
  });
  expect(result.review.minimumOutputRaw).toBe('995000');
});
it.each(['995995', '995996'] as const)(
  'enforces fresh-reference tolerance through every runtime review at %s',
  async (referenceMinimum) => {
    const { f, run } = await setup();
    f.runtimeState.onCodeRead = () => {};
    const quote = f.quote.getMockImplementation()!;
    let calls = 0;
    f.quote.mockImplementation(async (...args) => {
      const result = await quote(...args);
      return ++calls === 2
        ? { ...result, minimumOutAmount: referenceMinimum }
        : result;
    });
    if (referenceMinimum === '995995') {
      const result = await run();
      expect(result.review).toMatchObject({
        minimumOutputRaw: '995000',
        freshReferenceMinimumRaw: referenceMinimum,
        freshReferenceToleranceBps: 10,
        signingAllowed: false,
      });
      expect(f.runtimeState.codeReads).toBe(f.programs.size * 6);
      expect(
        f.rpc.mock.calls.filter(([m]) => m === 'simulateTransaction'),
      ).toHaveLength(1);
    } else {
      await expect(run()).rejects.toThrow(/fresh-reference tolerance/);
      expect(f.runtimeState.codeReads).toBe(0);
      expect(f.rpc.mock.calls.some(([m]) => m === 'simulateTransaction')).toBe(
        false,
      );
    }
  },
);
it('keeps a one-unit worse initial order strict before the fresh quote and code scan', async () => {
  const { f, run } = await setup();
  f.runtimeState.onCodeRead = () => {};
  const quote = f.quote.getMockImplementation()!;
  f.quote.mockImplementation(async (...args) => ({
    ...(await quote(...args)),
    minimumOutAmount: '995001',
  }));
  await expect(run()).rejects.toThrow(/original minimum/);
  expect(f.quote).toHaveBeenCalledOnce();
  expect(f.runtimeState.codeReads).toBe(0);
  expect(f.rpc.mock.calls.some(([m]) => m === 'simulateTransaction')).toBe(
    false,
  );
});
it.each(['changed-code', '33-slots', 'abort'] as const)(
  'refuses %s without publishing a qualification',
  async (mode) => {
    const { f, run } = await setup();
    const controller = new AbortController();
    f.runtimeState.onCodeRead = (key, count) => {
      if (count <= f.programs.size * 3) return;
      if (mode === 'changed-code')
        f.programs.get(key)!.data[0] = Buffer.from(
          new Uint8Array(256).fill(1),
        ).toString('base64');
      if (mode === 'abort') controller.abort();
    };
    if (mode === '33-slots') {
      const original = f.runtimeDependencies.programRpc!;
      f.runtimeDependencies.programRpc = async (method, params) => {
        const result = await original(method, params);
        if (
          method === 'getMultipleAccounts' &&
          result &&
          typeof result === 'object'
        )
          (result as { context: { slot: string } }).context.slot = String(
            (params[1] as { minContextSlot: number }).minContextSlot + 33,
          );
        return result;
      };
    }
    await expect(run(controller.signal)).rejects.toThrow();
    expect(
      f.sqlite
        .prepare('SELECT count(*) AS n FROM pair_order_first_reviews')
        .get()!.n,
    ).toBe(0);
  },
);
it('has no client-selectable qualification or signing flag', async () => {
  const { request } = await setup();
  expect(() =>
    pairOrderFirstRequest({ ...request, qualifyRuntime: true }),
  ).toThrow();
});

it('qualifies stock-only +1 Clock observations with later-slot evidence and both full scans', async () => {
  const { f, run } = await setup();
  f.runtimeState.onCodeRead = () => {};
  const original = f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async (method, params) => {
    const result = await original(method, params);
    if (
      method === 'getMultipleAccounts' &&
      (params[0] as string[]).includes(PAIR_CLOCK)
    ) {
      const r = result as { context: { slot: string }; value: unknown[] };
      for (const [i, key] of (params[0] as string[]).entries())
        if (key === PAIR_CLOCK)
          r.value[i] = pairQuoteClock(
            Number(r.context.slot) + 1,
            String(Math.floor(f.clock.now / 1000)),
          );
    }
    return result;
  });
  const result = await run();
  expect(result.clockObservations.length).toBeGreaterThan(3);
  for (const observation of result.clockObservations) {
    expect(observation.relation).toBe('+1');
    expect(observation.slot).toBe(observation.contextSlot + 1);
    expect(observation.slot).toBeLessThanOrEqual(result.runtime.maximumSlot);
  }
  expect(
    result.runtime.maximumSlot - result.runtime.minimumSlot,
  ).toBeLessThanOrEqual(32);
  expect(f.runtimeState.codeReads).toBe(f.programs.size * 6);
  expect(result.signingAllowed).toBe(false);
});

it('uses configured pacing by default even on a non-Helius provider', async () => {
  const { f, request } = await setup();
  vi.spyOn(solanaRpc, 'getSolanaStockRuntimeRpcEndpoint').mockReturnValue(
    'https://rpc.example.test/',
  );
  // Stop at reader construction; no real provider request or environment key is needed.
  const reader = vi
    .spyOn(pairReads, 'createPairReadRpc')
    .mockImplementation(() => {
      throw Error('reader construction boundary');
    });
  await expect(
    qualifyOwnedPairOrderFirstRuntime(
      f.db,
      'alice',
      request,
      new AbortController().signal,
    ),
  ).rejects.toThrow('reader construction boundary');
  expect(reader).toHaveBeenCalledExactlyOnceWith(
    'https://rpc.example.test/',
    expect.any(AbortSignal),
  );
});
