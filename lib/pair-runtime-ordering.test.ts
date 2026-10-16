import { afterEach, expect, it } from 'vitest';
import { pairRuntimeFixture } from '../test/pair-runtime-fixture';
import { previewOwnedImportedPairRuntime } from './imported-pair-runtime';
import { WalletRpcError } from './wallet-balances';
import { PAIR_CLOCK } from './pair-mint-evidence';
import { PAIR_RENT } from './pair-rent-evidence';
let fixture: Awaited<ReturnType<typeof pairRuntimeFixture>> | undefined;
afterEach(() => {
  fixture?.close();
  fixture = undefined;
});
function latch() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it('overlaps post-simulation candidate checks with fresh final code, then retains a custody tail check', async () => {
  const f = (fixture = await pairRuntimeFixture()),
    blocked = latch(),
    release = latch(),
    candidateFinal = latch();
  const normal = f.runtimeDependencies.rpc,
    code = f.runtimeDependencies.programRpc!;
  let simulated = false,
    held = false,
    published = false,
    tailAfterRelease = false,
    released = false;
  f.runtimeState.onTrace = (trace) => {
    simulated = true;
    return trace;
  };
  f.runtimeDependencies.programRpc = async (method, params) => {
    if (simulated && !held && method === 'getMultipleAccounts') {
      held = true;
      blocked.resolve();
      await release.promise;
    }
    return code(method, params);
  };
  f.runtimeDependencies.rpc = async (method, params) => {
    if (simulated && method === 'isBlockhashValid') candidateFinal.resolve();
    const keys = params[0] as string[],
      config = params[1] as { dataSlice?: unknown } | undefined;
    if (
      simulated &&
      method === 'getMultipleAccounts' &&
      !config?.dataSlice &&
      keys.includes(PAIR_RENT) &&
      !keys.includes(PAIR_CLOCK)
    )
      tailAfterRelease = released;
    return normal(method, params);
  };
  const work = previewOwnedImportedPairRuntime(
    f.db,
    'alice',
    f.runtimeRequest,
    new AbortController().signal,
    f.runtimeDependencies,
  );
  void work.then(
    () => {
      published = true;
    },
    () => {},
  );
  try {
    await Promise.all([blocked.promise, candidateFinal.promise]);
    expect(published).toBe(false);
    released = true;
    release.resolve();
    expect(await work).toMatchObject({
      signingAllowed: false,
      executionAllowed: false,
    });
    expect(tailAfterRelease).toBe(true);
  } finally {
    release.resolve();
    await work.catch(() => {});
  }
});
it.each(['code', 'accounts'] as const)(
  'overlaps static fee checks with initial %s and waits before simulation',
  async (held) => {
    const f = (fixture = await pairRuntimeFixture()),
      blocked = latch(),
      release = latch(),
      fee = latch();
    const normal = f.runtimeDependencies.rpc,
      code = f.runtimeDependencies.programRpc!;
    let heldOnce = false,
      simulation = false;
    f.runtimeDependencies.programRpc = async (method, params) => {
      if (held === 'code' && !heldOnce && method === 'getMultipleAccounts') {
        heldOnce = true;
        blocked.resolve();
        await release.promise;
      }
      return code(method, params);
    };
    f.runtimeDependencies.rpc = async (method, params) => {
      const keys = params[0] as string[],
        config = params[1] as { dataSlice?: unknown } | undefined;
      if (
        held === 'accounts' &&
        !heldOnce &&
        method === 'getMultipleAccounts' &&
        !config?.dataSlice &&
        keys.includes(PAIR_RENT) &&
        !keys.includes(PAIR_CLOCK)
      ) {
        heldOnce = true;
        blocked.resolve();
        await release.promise;
      }
      if (method === 'getFeeForMessage') fee.resolve();
      if (method === 'simulateTransaction') simulation = true;
      return normal(method, params);
    };
    const work = previewOwnedImportedPairRuntime(
      f.db,
      'alice',
      f.runtimeRequest,
      new AbortController().signal,
      f.runtimeDependencies,
    );
    try {
      await Promise.all([blocked.promise, fee.promise]);
      expect(simulation).toBe(false);
      release.resolve();
      expect(await work).toMatchObject({
        signingAllowed: false,
        executionAllowed: false,
        runtime: { codeIdentityObserved: true },
      });
      expect(simulation).toBe(true);
    } finally {
      release.resolve();
      await work.catch(() => {});
    }
  },
);
it('denies simulation when a parallel first code observation fails after static fees are read', async () => {
  const f = (fixture = await pairRuntimeFixture()),
    fee = latch(),
    blocked = latch(),
    release = latch();
  const normal = f.runtimeDependencies.rpc,
    code = f.runtimeDependencies.programRpc!;
  let once = false;
  f.runtimeDependencies.rpc = async (method, params) => {
    if (method === 'getFeeForMessage') fee.resolve();
    return normal(method, params);
  };
  f.runtimeDependencies.programRpc = async (method, params) => {
    if (!once && method === 'getMultipleAccounts') {
      once = true;
      blocked.resolve();
      await release.promise;
      throw new WalletRpcError(429);
    }
    return code(method, params);
  };
  const work = previewOwnedImportedPairRuntime(
    f.db,
    'alice',
    f.runtimeRequest,
    new AbortController().signal,
    f.runtimeDependencies,
  );
  try {
    await Promise.all([fee.promise, blocked.promise]);
    release.resolve();
    await expect(work).rejects.toMatchObject({ status: 429 });
    expect(
      f.rpc.mock.calls.some(([method]) => method === 'simulateTransaction'),
    ).toBe(false);
  } finally {
    release.resolve();
    await work.catch(() => {});
  }
});
