import { it, expect, beforeEach, afterEach, vi } from 'vitest';
beforeEach(() => vi.stubEnv('SOLANA_STOCK_RUNTIME_ACCOUNT_LIMIT', '5'));
afterEach(() => vi.unstubAllEnvs());
import { setImmediate as nextTurn } from 'node:timers';
import { pairRuntimeFixture } from '../test/pair-runtime-fixture';
import { inspectOwnedImportedPairOrder } from './imported-pair-order-candidate';
import { collectPairRuntimePreview } from './pair-runtime-preview';
import { createStockPairEvidenceRpc } from './pair-stock-clock';
async function run(profile?: 1 | 4) {
  const f = await pairRuntimeFixture();
  try {
    for (const program of f.programs.values()) {
      const bytes = new Uint8Array(800000);
      bytes.set([127, 69, 76, 70, 19]);
      program.data = [Buffer.from(bytes).toString('base64'), 'base64'];
      program.space = String(bytes.length);
    }
    const source = f.runtimeDependencies.programRpc!;
    let active = 0,
      peak = 0;
    const calls: { method: string; params: unknown[] }[] = [];
    const code = async (method: string, params: unknown[]) => {
      calls.push({ method, params: structuredClone(params) });
      const config = params[1] as
        | { dataSlice?: { length: number } }
        | undefined;
      const body =
        method === 'getMultipleAccounts' &&
        (config?.dataSlice?.length ?? 0) > 64;
      if (body) {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => nextTurn(resolve));
      }
      try {
        return await source(method, params);
      } finally {
        if (body) active--;
      }
    };
    const signal = new AbortController().signal;
    const result = await inspectOwnedImportedPairOrder(
      f.db,
      'alice',
      f.orderRequest,
      signal,
      f.runtimeDependencies,
      async (preflight, order, rpc, now) =>
        collectPairRuntimePreview(
          { preflight, order },
          rpc,
          code,
          signal,
          now,
          'strict',
          100,
          profile,
        ),
    );
    expect(result.signingAllowed).toBe(false);
    expect(result.review.codeScans[0]).toEqual(result.review.codeScans[1]);
    return { result: result.review, peak, calls };
  } finally {
    f.close();
  }
}
it('preserves the default four-read trace and supports an explicit serial full-code profile', async () => {
  const original = await run(),
    explicit = await run(4),
    serial = await run(1);
  expect(original.calls).toEqual(explicit.calls);
  expect(original.peak).toBeGreaterThan(1);
  expect(original.peak).toBeLessThanOrEqual(4);
  expect(serial.peak).toBe(1);
  expect(serial.result.codeScans).toEqual(original.result.codeScans);
  expect(serial.result.runtime).toMatchObject({
    codeIdentityObserved: true,
    trustedProgramPolicyEstablished: false,
    signingAllowed: false,
    executionAllowed: false,
  });
});
it('refuses serial code on the five-account stock scope before any provider read', async () => {
  const f = await pairRuntimeFixture();
  try {
    let calls = 0;
    const rpc = async () => {
      calls++;
      throw Error('must not read');
    };
    const scope = createStockPairEvidenceRpc(rpc, rpc, Date.now, {
      endpoint: 'https://fixture.quiknode.pro/',
      signal: new AbortController().signal,
    });
    await expect(
      collectPairRuntimePreview(
        {} as Parameters<typeof collectPairRuntimePreview>[0],
        scope.rpc,
        scope.programRpc,
        new AbortController().signal,
        Date.now,
        'strict',
        5,
        1,
      ),
    ).rejects.toThrow('profile');
    expect(calls).toBe(0);
  } finally {
    f.close();
  }
});
it.each([0, 2, 3, null, '1'])(
  'refuses invalid runtime code concurrency %s before reads',
  async (value) => {
    let calls = 0;
    const rpc = async () => {
      calls++;
      throw Error('must not read');
    };
    await expect(
      collectPairRuntimePreview(
        {} as Parameters<typeof collectPairRuntimePreview>[0],
        rpc,
        rpc,
        new AbortController().signal,
        Date.now,
        'strict',
        100,
        value as 1,
      ),
    ).rejects.toThrow('profile');
    expect(calls).toBe(0);
  },
);
it('refuses serial code when only the program channel has a five-account stock scope', async () => {
  let calls = 0;
  const rpc = async () => {
    calls++;
    throw Error('must not read');
  };
  const scope = createStockPairEvidenceRpc(rpc, rpc, Date.now, {
    endpoint: 'https://fixture.quiknode.pro/',
    signal: new AbortController().signal,
  });
  await expect(
    collectPairRuntimePreview(
      {} as Parameters<typeof collectPairRuntimePreview>[0],
      rpc,
      scope.programRpc,
      new AbortController().signal,
      Date.now,
      'strict',
      100,
      1,
    ),
  ).rejects.toThrow('profile');
  expect(calls).toBe(0);
});
