/** Composition test with an explicit runtime-stage double. Raw swap, asset,
 * lookup, fee/frame and economic replay are real. This fixture has deliberately
 * fake program code and MUST NOT be described as actual runtime qualification. */
import { expect, it, vi } from 'vitest';
import { jitoRawResponseFixture } from './jito-raw-response-fixture';
import { captureJitoSwapSimulation } from '../lib/jito-swap-simulation-capture';
import { collectJitoReadOnlyQualification } from '../lib/jito-readonly-qualification';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
import { PAIR_RENT } from '../lib/pair-rent-evidence';
const doubles = vi.hoisted(() => ({
  scans: vi.fn(),
  check: vi.fn(),
  assetRead: vi.fn(),
  attempt: vi.fn(),
}));
const fixtureBody = (init?: RequestInit) => {
  if (typeof init?.body !== 'string')
    throw Error('Expected fixture request body');
  return JSON.parse(init.body);
};
vi.mock('../lib/jito-runtime-evidence', async (original) => ({
  ...(await original<typeof import('../lib/jito-runtime-evidence')>()),
  collectJitoRuntimeEvidence: doubles.scans,
  verifyJitoRuntimeBracket: doubles.check,
}));

vi.mock('../lib/jito-asset-evidence', async (original) => {
  const real = await original<typeof import('../lib/jito-asset-evidence')>();
  return {
    ...real,
    readJitoAssetEvidence: async (
      ...args: Parameters<typeof real.readJitoAssetEvidence>
    ) => {
      const result = await real.readJitoAssetEvidence(...args);
      doubles.assetRead(result);
      return result;
    },
  };
});

vi.mock('../lib/jito-coherent-simulation-attempt', async (original) => {
  const real =
    await original<typeof import('../lib/jito-coherent-simulation-attempt')>();
  return {
    ...real,
    collectJitoCoherentSimulationAttempt: (
      ...args: Parameters<typeof real.collectJitoCoherentSimulationAttempt>
    ) => {
      doubles.attempt();
      return real.collectJitoCoherentSimulationAttempt(...args);
    },
  };
});

async function fixture(
  options: {
    side?: 'Buy' | 'Sell';
    lookup?: boolean;
    token2022?: boolean;
    wallets?: number;
  } = {},
  failure = 'none',
) {
  const f = await jitoRawResponseFixture(options),
    e = f.fixture,
    original = e.observations[0];
  const account = (value: unknown) => {
    if (value === null) return null;
    const a = value as {
      owner: string;
      executable: boolean;
      lamports?: string;
      data: string[];
    };
    return {
      ...a,
      lamports: BigInt(a.lamports ?? '1000000'),
      rentEpoch: (1n << 64n) - 1n,
      space: BigInt(Buffer.from(a.data[0], 'base64').length),
    };
  };
  const response = (id: unknown, result: unknown) =>
    new Response(f.wire({ jsonrpc: '2.0', id, result }));
  const baselineFor = (index: number): typeof fetch => {
    const original = e.observations[index],
      s = original.simulation,
      se = s.settlementEvidence!,
      frame = e.result.value.transactionResults[index];
    return async (_url, init) => {
      const r = fixtureBody(init);
      let result: unknown;
      if (r.method === 'getGenesisHash') result = SOLANA_MAINNET_GENESIS;
      else if (r.method === 'getBlockHeight') result = 100;
      else if (r.method === 'getFeeForMessage')
        result = { context: { slot: 100n }, value: 5000n };
      else if (r.method === 'getMinimumBalanceForRentExemption')
        result = r.params[0] === 170 ? 2074080n : 2039280n;
      else if (r.method === 'getMultipleAccounts')
        result = {
          context: { slot: BigInt(Math.max(100, r.params[1].minContextSlot)) },
          value: r.params[0].map((key: string) => {
            const mint = [
              original.order.inputMint,
              original.order.outputMint,
            ].indexOf(key);
            if (mint >= 0) return original.mintAccounts.before[mint];
            const table = e.lookupAccounts.find((a) => a.address === key);
            if (table) return table.account;
            const at = se.keys.indexOf(key);
            if (at < 0) throw Error('Unexpected baseline key');
            return frame.preExecutionAccounts[at];
          }),
        };
      else if (r.method === 'simulateTransaction')
        result = {
          context: { slot: 101n },
          value: {
            err: null,
            unitsConsumed: s.unitsConsumed,
            preBalances: se.before,
            postBalances: se.after,
            preTokenBalances: se.preTokens,
            postTokenBalances: se.postTokens,
            accounts: se.postAccounts,
            loadedAddresses: frame.loadedAddresses,
            replacementBlockhash: null,
          },
        };
      else throw Error('Unexpected baseline method');
      return response(r.id, result);
    };
  };
  const capsules = [];
  for (let i = 0; i < e.observations.length; i++)
    capsules.push(
      await captureJitoSwapSimulation(
        e.observations[i].order,
        new AbortController().signal,
        baselineFor(i),
      ),
    );
  const capsule = capsules[0];
  const methods: string[] = [];
  let observed = false;
  const fetcher: typeof fetch = async (_url, init) => {
    const r = fixtureBody(init);
    methods.push(Array.isArray(r) ? 'batch' : r.method);
    if (Array.isArray(r)) {
      observed = true;
      return new Response(
        f.wire(
          r.map((row) =>
            row.method === 'getFeeForMessage'
              ? {
                  jsonrpc: '2.0',
                  id: row.id,
                  result: { context: { slot: 101n }, value: 5000n },
                }
              : { ...f.envelope, id: row.id },
          ),
        ),
      );
    }
    if (r.method === 'getGenesisHash')
      return response(r.id, SOLANA_MAINNET_GENESIS);
    if (r.method === 'simulateBundle')
      return new Response(f.wire({ ...f.envelope, id: r.id }));
    if (r.method === 'getMultipleAccounts') {
      const keys = r.params[0] as string[];
      const values = keys.map((key) => {
        if (key === PAIR_RENT) {
          const a = account(e.rentAccounts.before)!;
          if (failure === 'rent-change' && observed) {
            const b = Buffer.from(a.data[0], 'base64');
            b[0] ^= 1;
            a.data = [b.toString('base64'), 'base64'];
          }
          return a;
        }
        const at = [
          original.order.inputMint,
          original.order.outputMint,
        ].indexOf(key);
        if (at >= 0) return account(original.mintAccounts.before[at]);
        const table = e.lookupAccounts.find((a) => a.address === key);
        if (!table) throw Error('Unexpected bundle key');
        return account(table.account);
      });
      return response(r.id, {
        context: {
          slot:
            failure === 'late-slot' && observed
              ? 133n
              : BigInt(
                  Math.max(observed ? 102 : 101, r.params[1].minContextSlot),
                ),
        },
        value: values,
      });
    }
    throw Error('Unexpected diagnostic method');
  };
  doubles.attempt.mockReset();
  doubles.assetRead.mockReset();
  doubles.scans.mockReset();
  doubles.check.mockReset();
  doubles.scans.mockImplementation(
    async (keys: string[], minimumSlot: number, minimumReadSlot: number) => ({
      format: 'test-double-not-runtime-proof',
      keys,
      minimumSlot,
      minimumReadSlot,
      maximumSlot: minimumReadSlot,
    }),
  );
  doubles.check.mockResolvedValue({
    conservativeRuntimeChecksPassed: true,
    runtimePrivilegesVerified: false,
    runtimeAttested: false,
    fixtureOnly: true,
  });
  return { f, e, capsule, capsules, fetcher, methods };
}
for (const side of ['Buy', 'Sell'] as const)
  for (const lookup of [false, true])
    for (const token2022 of [false, true])
      it(`composes full raw ${side}/ALT=${lookup}/2022=${token2022} economics with a declared runtime double`, async () => {
        const x = await fixture({ side, lookup, token2022 });
        const result = await collectJitoReadOnlyQualification(
          x.e.manifest,
          [x.capsule],
          new AbortController().signal,
          { fetcher: x.fetcher, pace: async () => {} },
        );
        expect(result).toMatchObject({
          status: 'checks-passed',
          rawSimulationChecksPassed: true,
          readOnlyLocalChecksPassed: true,
          fullProviderQualification: false,
          signingAllowed: false,
          executionAllowed: false,
          runtimePrivilegesVerified: false,
          runtimeAttested: false,
        });
        if (result.status === 'checks-passed') {
          expect(result.economic.frameEconomicChecksPassed).toBe(true);
          expect(result.assetProof.mintPolicyChecksPassed).toBe(true);
          expect(result.economic.outcomes).toHaveLength(1);
          expect(result.runtimeProof).toHaveProperty('fixtureOnly', true);
        }
        expect(doubles.scans).toHaveBeenCalledTimes(2);
        expect(doubles.check).toHaveBeenCalledTimes(1);
        expect(x.methods.filter((m) => m === 'batch')).toHaveLength(1);
      });
for (const failure of ['rent-change', 'late-slot'])
  it(`refuses ${failure} with no signing clearance or renewed floor`, async () => {
    const x = await fixture({ lookup: true }, failure);
    const result = await collectJitoReadOnlyQualification(
      x.e.manifest,
      [x.capsule],
      new AbortController().signal,
      { fetcher: x.fetcher, pace: async () => {} },
    );
    expect(result).toMatchObject({
      status: 'refused',
      minimumSlot: 100,
      readOnlyLocalChecksPassed: false,
      signingAllowed: false,
      executionAllowed: false,
    });
  });

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it('isolates concurrent refusal stages, cancellation and later setup diagnostics', async () => {
  const a = await fixture();
  const b = await fixture();
  const aStarted = deferred();
  const bStarted = deferred();
  const releaseB = deferred();
  const cancelA = new AbortController();
  let bSignal: AbortSignal | null = null;

  const fetchA: typeof fetch = async (_url, init) => {
    if (fixtureBody(init).method !== 'getGenesisHash')
      throw Error('Unexpected first invocation request');
    aStarted.resolve();
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener(
        'abort',
        () => reject(Error('Cancelled')),
        {
          once: true,
        },
      );
      if (init!.signal!.aborted) reject(Error('Already cancelled'));
    });
  };
  const fetchB: typeof fetch = async (url, init) => {
    if (fixtureBody(init).id === 'jito-assets:after') {
      bSignal = init!.signal!;
      bStarted.resolve();
      await releaseB.promise;
    }
    return b.fetcher(url, init);
  };
  const pendingA = collectJitoReadOnlyQualification(
    a.e.manifest,
    [a.capsule],
    cancelA.signal,
    { fetcher: fetchA, pace: async () => {} },
  );
  await aStarted.promise;
  const pendingB = collectJitoReadOnlyQualification(
    b.e.manifest,
    [b.capsule],
    new AbortController().signal,
    { fetcher: fetchB, pace: async () => {} },
  );
  await bStarted.promise;
  cancelA.abort();
  const refused = await pendingA;
  expect(refused).toMatchObject({ status: 'refused', stage: 'network' });
  expect(refused.evidence.timing.events).toContainEqual(
    expect.objectContaining({ phase: 'network', event: 'refused' }),
  );
  expect(bSignal!.aborted).toBe(false);
  releaseB.resolve();
  const completed = await pendingB;
  expect(completed).toMatchObject({
    status: 'checks-passed',
    stage: 'replay',
    signingAllowed: false,
    executionAllowed: false,
  });
  await expect(
    collectJitoReadOnlyQualification(
      a.e.manifest,
      [],
      new AbortController().signal,
      { fetcher: fetchA, pace: async () => {} },
    ),
  ).rejects.toThrow('Jito read-only qualification refused at setup');
});
it('starts both independent preflight reads but waits for both before simulation', async () => {
  const x = await fixture();
  const assetStarted = deferred(),
    scanStarted = deferred(),
    releaseAsset = deferred(),
    releaseScan = deferred();
  const assetDone = deferred();
  doubles.assetRead.mockImplementationOnce(() => assetDone.resolve());
  const originalScan = doubles.scans.getMockImplementation()!;
  let scans = 0;
  doubles.scans.mockImplementation(async (...args) => {
    if (++scans === 1) {
      scanStarted.resolve();
      await releaseScan.promise;
    }
    return originalScan(...args);
  });
  const fetcher: typeof fetch = async (url, init) => {
    if (fixtureBody(init).id === 'jito-assets:before') {
      assetStarted.resolve();
      await releaseAsset.promise;
    }
    return x.fetcher(url, init);
  };
  const pending = collectJitoReadOnlyQualification(
    x.e.manifest,
    [x.capsule],
    new AbortController().signal,
    { fetcher, pace: async () => {} },
  );
  await Promise.all([assetStarted.promise, scanStarted.promise]);
  expect(x.methods).not.toContain('batch');
  releaseAsset.resolve();
  await assetDone.promise;
  // Observe controller entry, not a later fetch that can be delayed by hashing.
  await new Promise<void>((done) => setImmediate(done));
  expect(doubles.attempt).not.toHaveBeenCalled();
  expect(x.methods).not.toContain('batch');
  releaseScan.resolve();
  const result = await pending;
  expect(result).toMatchObject({
    status: 'checks-passed',
    minimumSlot: 100,
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(doubles.scans).toHaveBeenCalledTimes(2);
  expect(doubles.scans.mock.calls[0][2]).toBe(101);
});
it('aborts a pending asset transport on initial scan refusal without a simulation or final scan', async () => {
  const x = await fixture();
  const assetStarted = deferred();
  let assetSignal: AbortSignal | undefined;
  let finish!: (response: Response) => void;
  doubles.scans.mockImplementation(async () => {
    await assetStarted.promise;
    throw Error('Deliberate initial policy refusal');
  });
  const fetcher: typeof fetch = async (url, init) => {
    if (fixtureBody(init).id === 'jito-assets:before') {
      assetSignal = init?.signal ?? undefined;
      assetStarted.resolve();
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }
    return x.fetcher(url, init);
  };
  const result = await collectJitoReadOnlyQualification(
    x.e.manifest,
    [x.capsule],
    new AbortController().signal,
    { fetcher, pace: async () => {} },
  );
  expect(result).toMatchObject({
    status: 'refused',
    stage: 'runtime-before',
    signingAllowed: false,
  });
  expect(assetSignal?.aborted).toBe(true);
  expect(x.methods).not.toContain('batch');
  expect(doubles.scans).toHaveBeenCalledTimes(1);
  const retained = JSON.stringify(result);
  const retainedTiming = JSON.stringify(result.evidence.timing);
  finish(new Response('{}'));
  await Promise.resolve();
  await Promise.resolve();
  expect(JSON.stringify(result)).toBe(retained);
  expect(JSON.stringify(result.evidence.timing)).toBe(retainedTiming);
  expect(result.evidence.timing.events.at(-1)).toMatchObject({
    phase: 'collector',
    event: 'refused',
  });
});
for (const parsed of [false, true])
  it(`aborts the initial runtime branch on ${parsed ? 'RPC' : 'HTTP'} 429 with no later phase`, async () => {
    const x = await fixture();
    const scanStarted = deferred();
    let scanSignal: AbortSignal | undefined;
    doubles.scans.mockImplementation(
      async (_keys, _minimum, _floor, signal: AbortSignal) => {
        scanSignal = signal;
        scanStarted.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(Error('Sibling cancelled')),
            { once: true },
          );
          if (signal.aborted) reject(Error('Already cancelled'));
        });
      },
    );
    const fetcher: typeof fetch = async (url, init) => {
      const request = fixtureBody(init);
      if (request.id === 'jito-assets:before') {
        await scanStarted.promise;
        return parsed
          ? new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: request.id,
                error: { code: 429, message: 'Limited' },
              }),
            )
          : new Response(null, { status: 429 });
      }
      return x.fetcher(url, init);
    };
    const result = await collectJitoReadOnlyQualification(
      x.e.manifest,
      [x.capsule],
      new AbortController().signal,
      { fetcher, pace: async () => {} },
    );
    expect(result).toMatchObject({
      status: 'refused',
      stage: 'assets-before',
      signingAllowed: false,
      executionAllowed: false,
    });
    expect(scanSignal?.aborted).toBe(true);
    expect(x.methods).not.toContain('batch');
    expect(doubles.scans).toHaveBeenCalledTimes(1);
    expect(result.evidence.transports[1].summary.rateLimited).toBe(true);
  });

for (const parsed of [false, true])
  it(`cancels a pending asset sibling on real runtime transport ${parsed ? 'RPC' : 'HTTP'} 429`, async () => {
    const x = await fixture();
    const assetStarted = deferred();
    let assetSignal: AbortSignal | undefined;
    let finish!: (response: Response) => void;
    doubles.scans.mockImplementation(
      async (_keys, _minimum, _floor, signal, rpc) => {
        await assetStarted.promise;
        await rpc('getGenesisHash', [], signal);
        throw Error('Runtime 429 must not return');
      },
    );
    const fetcher: typeof fetch = async (url, init) => {
      const request = fixtureBody(init);
      if (request.id === 'jito-assets:before') {
        assetSignal = init?.signal ?? undefined;
        assetStarted.resolve();
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      if (String(request.id).startsWith('jito-runtime:'))
        return parsed
          ? new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: request.id,
                error: { code: 429, message: 'Limited' },
              }),
            )
          : new Response(null, { status: 429 });
      return x.fetcher(url, init);
    };
    const result = await collectJitoReadOnlyQualification(
      x.e.manifest,
      [x.capsule],
      new AbortController().signal,
      { fetcher, pace: async () => {} },
    );
    expect(result).toMatchObject({
      status: 'refused',
      stage: 'runtime-before',
      signingAllowed: false,
      executionAllowed: false,
    });
    expect(result.evidence.transports[2].summary.rateLimited).toBe(true);
    expect(assetSignal?.aborted).toBe(true);
    expect(x.methods).not.toContain('batch');
    expect(doubles.scans).toHaveBeenCalledTimes(1);
    finish(new Response('{}'));
  });
it('refuses an initial parallel branch beyond original F+32 before exact simulation', async () => {
  const x = await fixture();
  doubles.scans.mockImplementation(
    async (keys, minimumSlot, minimumReadSlot) => ({
      keys,
      minimumSlot,
      minimumReadSlot,
      maximumSlot: 133,
    }),
  );
  const result = await collectJitoReadOnlyQualification(
    x.e.manifest,
    [x.capsule],
    new AbortController().signal,
    { fetcher: x.fetcher, pace: async () => {} },
  );
  expect(result).toMatchObject({
    status: 'refused',
    stage: 'runtime-before',
    minimumSlot: 100,
    maximumSlot: 133,
    signingAllowed: false,
  });
  expect(result.evidence.timing).toMatchObject({
    diagnosticOnly: true,
    originalMinimumSlot: 100,
    maximumCapturedContextSlot: 133,
    contextSlotsAdmitted: false,
  });
  expect(x.methods).not.toContain('batch');
  expect(doubles.scans).toHaveBeenCalledTimes(1);
});

it('keeps F+32 admissible but refuses a discovery bank older than the completed phase', async () => {
  const x = await fixture();
  doubles.scans.mockImplementation(
    async (keys, minimumSlot, minimumReadSlot) => ({
      keys,
      minimumSlot,
      minimumReadSlot,
      maximumSlot: 132,
    }),
  );
  const result = await collectJitoReadOnlyQualification(
    x.e.manifest,
    [x.capsule],
    new AbortController().signal,
    { fetcher: x.fetcher, pace: async () => {} },
  );
  expect(result).toMatchObject({
    status: 'refused',
    stage: 'exact-simulation',
    minimumSlot: 100,
    maximumSlot: 132,
    signingAllowed: false,
  });
  expect(result.evidence.runtimeBefore).toMatchObject({
    minimumSlot: 100,
    minimumReadSlot: 101,
    maximumSlot: 132,
  });
  expect(result.evidence.attempt).not.toBeNull();
  expect(x.methods).toContain('simulateBundle');
  expect(x.methods).not.toContain('batch');
});

it('joins a later asset slot without raising the initial scan floor or accepting an older bank', async () => {
  const x = await fixture();
  const fetcher: typeof fetch = async (url, init) => {
    const response = await x.fetcher(url, init);
    if (fixtureBody(init).id !== 'jito-assets:before') return response;
    const body = await response.text();
    return new Response(body.replace('"slot":101', '"slot":103'));
  };
  const result = await collectJitoReadOnlyQualification(
    x.e.manifest,
    [x.capsule],
    new AbortController().signal,
    { fetcher, pace: async () => {} },
  );
  expect(result).toMatchObject({
    status: 'refused',
    stage: 'exact-simulation',
    minimumSlot: 100,
    maximumSlot: 103,
    signingAllowed: false,
  });
  expect(result.evidence.assetsBefore).toMatchObject({ slot: 103 });
  expect(doubles.scans.mock.calls[0][2]).toBe(101);
  expect(result.evidence.attempt).toMatchObject({ status: 'refused' });
  expect(x.methods).not.toContain('batch');
});

it('retains a completed asset read when its pending runtime sibling later refuses', async () => {
  const x = await fixture();
  const assetDone = deferred();
  doubles.assetRead.mockImplementationOnce(() => assetDone.resolve());
  doubles.scans.mockImplementation(async () => {
    await assetDone.promise;
    throw Error('Deliberate delayed scan refusal');
  });
  const result = await collectJitoReadOnlyQualification(
    x.e.manifest,
    [x.capsule],
    new AbortController().signal,
    { fetcher: x.fetcher, pace: async () => {} },
  );
  expect(result).toMatchObject({
    status: 'refused',
    stage: 'runtime-before',
    diagnosis: null,
    signingAllowed: false,
  });
  expect(result.evidence.assetsBefore).toMatchObject({ slot: 101 });
  expect(result.evidence.runtimeBefore).toBeNull();
  expect(doubles.attempt).not.toHaveBeenCalled();
});

it('starts all three postflight reads after simulation and holds final genesis/replay for their barrier', async () => {
  const x = await fixture({ lookup: true });
  const assetStarted = deferred(),
    lookupStarted = deferred(),
    scanStarted = deferred();
  const releaseAsset = deferred(),
    releaseLookup = deferred(),
    releaseScan = deferred();
  const originalScan = doubles.scans.getMockImplementation()!;
  let simulated = false,
    scans = 0;
  const floors: number[] = [];
  doubles.scans.mockImplementation(async (...args) => {
    if (++scans === 2) {
      expect(simulated).toBe(true);
      floors.push(args[2]);
      scanStarted.resolve();
      await releaseScan.promise;
    }
    return originalScan(...args);
  });
  const table = x.e.lookupAccounts[0].address;
  const fetcher: typeof fetch = async (url, init) => {
    const request = fixtureBody(init);
    if (request.id === 'jito-assets:after') {
      expect(simulated).toBe(true);
      floors.push(request.params[1].minContextSlot);
      assetStarted.resolve();
      await releaseAsset.promise;
    } else if (
      simulated &&
      request.method === 'getMultipleAccounts' &&
      request.params[0].includes(table)
    ) {
      floors.push(request.params[1].minContextSlot);
      lookupStarted.resolve();
      await releaseLookup.promise;
    }
    const response = await x.fetcher(url, init);
    if (Array.isArray(request)) simulated = true;
    return response;
  };
  const pending = collectJitoReadOnlyQualification(
    x.e.manifest,
    [x.capsule],
    new AbortController().signal,
    { fetcher, pace: async () => {} },
  );
  await Promise.all([
    assetStarted.promise,
    lookupStarted.promise,
    scanStarted.promise,
  ]);
  expect(floors).toEqual([101, 101, 101]);
  expect(x.methods.filter((m) => m === 'getGenesisHash')).toHaveLength(1);
  expect(doubles.check).not.toHaveBeenCalled();
  releaseAsset.resolve();
  releaseLookup.resolve();
  await new Promise<void>((done) => setImmediate(done));
  expect(x.methods.filter((m) => m === 'getGenesisHash')).toHaveLength(1);
  expect(doubles.check).not.toHaveBeenCalled();
  releaseScan.resolve();
  const result = await pending;
  expect(result).toMatchObject({
    status: 'checks-passed',
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(x.methods.filter((m) => m === 'getGenesisHash')).toHaveLength(2);
  expect(doubles.check).toHaveBeenCalledOnce();
  expect(doubles.scans).toHaveBeenCalledTimes(2);
});

for (const branch of ['assets', 'lookup', 'runtime'] as const)
  for (const slot of [132, 133])
    it(`keeps original F+32 but refuses F+33 from postflight ${branch} (slot ${slot})`, async () => {
      const x = await fixture({ lookup: true });
      const originalScan = doubles.scans.getMockImplementation()!;
      let simulated = false,
        scans = 0;
      doubles.scans.mockImplementation(async (...args) => {
        const value = await originalScan(...args);
        return ++scans === 2 && branch === 'runtime'
          ? { ...value, maximumSlot: slot }
          : value;
      });
      const table = x.e.lookupAccounts[0].address;
      const fetcher: typeof fetch = async (url, init) => {
        const request = fixtureBody(init),
          response = await x.fetcher(url, init);
        if (Array.isArray(request)) simulated = true;
        const selected =
          branch === 'assets'
            ? request.id === 'jito-assets:after'
            : branch === 'lookup' &&
              simulated &&
              request.method === 'getMultipleAccounts' &&
              request.params[0].includes(table);
        if (!selected) return response;
        return new Response(
          (await response.text()).replace('"slot":102', '"slot":' + slot),
        );
      };
      const result = await collectJitoReadOnlyQualification(
        x.e.manifest,
        [x.capsule],
        new AbortController().signal,
        { fetcher, pace: async () => {} },
      );
      expect(result).toMatchObject({
        status: slot === 132 ? 'checks-passed' : 'refused',
        minimumSlot: 100,
        maximumSlot: slot,
        signingAllowed: false,
        executionAllowed: false,
      });
      if (slot === 132) {
        expect(result.evidence.runtimeAfter).toMatchObject({
          minimumReadSlot: 101,
        });
        expect(doubles.check).toHaveBeenCalledOnce();
      } else {
        expect(doubles.check).not.toHaveBeenCalled();
        expect(x.methods.filter((m) => m === 'getGenesisHash')).toHaveLength(1);
      }
    });

for (const branch of ['assets', 'lookup', 'runtime'] as const)
  for (const parsed of [false, true])
    it(`stops all postflight siblings on ${branch} ${parsed ? 'RPC' : 'HTTP'} 429`, async () => {
      const x = await fixture({ lookup: true });
      const originalScan = doubles.scans.getMockImplementation()!;
      const assetStarted = deferred(),
        lookupStarted = deferred(),
        scanStarted = deferred();
      const started = Promise.all([
        assetStarted.promise,
        lookupStarted.promise,
        scanStarted.promise,
      ]);
      const signals: AbortSignal[] = [],
        late: Array<(response: Response) => void> = [];
      let scans = 0,
        simulated = false;
      let returned = false;
      const abortEvents: Array<{ stage: string; afterReturn: boolean }> = [];
      doubles.scans.mockImplementation(async (...args) => {
        if (++scans === 1) return originalScan(...args);
        const signal = args[3] as AbortSignal;
        signals.push(signal);
        signal.addEventListener(
          'abort',
          () => abortEvents.push({ stage: 'runtime', afterReturn: returned }),
          { once: true },
        );
        scanStarted.resolve();
        if (branch === 'runtime') {
          await started;
          await args[4]('getGenesisHash', [], signal);
          throw Error('Runtime rate limit must refuse');
        }
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(Error('Sibling stopped')),
            { once: true },
          );
          if (signal.aborted) reject(Error('Stopped'));
        });
      });
      const limited = (id: string) =>
        parsed
          ? new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id,
                error: { code: 429, message: 'Limited' },
              }),
            )
          : new Response(null, { status: 429 });
      const table = x.e.lookupAccounts[0].address;
      const fetcher: typeof fetch = async (url, init) => {
        const request = fixtureBody(init);
        let current: 'assets' | 'lookup' | undefined;
        if (request.id === 'jito-assets:after') {
          current = 'assets';
          assetStarted.resolve();
        } else if (
          simulated &&
          request.method === 'getMultipleAccounts' &&
          request.params[0].includes(table)
        ) {
          current = 'lookup';
          lookupStarted.resolve();
        }
        if (current) {
          signals.push(init!.signal!);
          init!.signal!.addEventListener(
            'abort',
            () => abortEvents.push({ stage: current!, afterReturn: returned }),
            { once: true },
          );
          if (branch === current) {
            await started;
            return limited(request.id);
          }
          return new Promise<Response>((resolve) => late.push(resolve));
        }
        if (String(request.id).startsWith('jito-runtime:'))
          return limited(request.id);
        const response = await x.fetcher(url, init);
        if (Array.isArray(request)) simulated = true;
        return response;
      };
      const result = await collectJitoReadOnlyQualification(
        x.e.manifest,
        [x.capsule],
        new AbortController().signal,
        { fetcher, pace: async () => {} },
      );
      returned = true;
      expect(abortEvents).toHaveLength(3);
      expect(abortEvents.every((event) => !event.afterReturn)).toBe(true);
      expect(result).toMatchObject({
        status: 'refused',
        stage:
          branch === 'lookup'
            ? 'lookup-after'
            : branch === 'assets'
              ? 'assets-after'
              : 'runtime-after',
        signingAllowed: false,
        executionAllowed: false,
      });
      expect(signals).toHaveLength(3);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(
        result.evidence.transports[
          branch === 'assets' ? 1 : branch === 'lookup' ? 0 : 3
        ].summary.rateLimited,
      ).toBe(true);
      expect(x.methods.filter((m) => m === 'getGenesisHash')).toHaveLength(1);
      expect(doubles.check).not.toHaveBeenCalled();
      const snapshot = structuredClone(result);
      late.forEach((resolve) => resolve(new Response('{}')));
      await new Promise<void>((done) => setImmediate(done));
      expect(result).toEqual(snapshot);
    });

it('retains completed postflight assets when the final scan later refuses', async () => {
  const x = await fixture({ lookup: true });
  const originalScan = doubles.scans.getMockImplementation()!;
  const assetDone = deferred();
  let assetReads = 0,
    scans = 0;
  doubles.assetRead.mockImplementation(() => {
    if (++assetReads === 2) assetDone.resolve();
  });
  doubles.scans.mockImplementation(async (...args) => {
    if (++scans === 1) return originalScan(...args);
    await assetDone.promise;
    await new Promise<void>((done) => setImmediate(done));
    throw Error('Final scan refused after completed asset read');
  });
  const result = await collectJitoReadOnlyQualification(
    x.e.manifest,
    [x.capsule],
    new AbortController().signal,
    { fetcher: x.fetcher, pace: async () => {} },
  );
  expect(result).toMatchObject({
    status: 'refused',
    stage: 'runtime-after',
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(result.evidence.assetsAfter).toMatchObject({ slot: 102 });
  expect(result.evidence.runtimeAfter).toBeNull();
  expect(doubles.check).not.toHaveBeenCalled();
  expect(x.methods.filter((m) => m === 'getGenesisHash')).toHaveLength(1);
});

/** Uses two real raw captures and real ALT/asset/economic parsers, with the
 * file's explicit fake-code runtime double. This is not live qualification. */
async function multiLookupFixture(
  failure: 'none' | 'stale-second' | 'changed-second' = 'none',
) {
  const x = await fixture({ lookup: true, wallets: 2 });
  const assetDone = deferred();
  doubles.assetRead.mockImplementation((read: { slot: number }) => {
    if (read.slot === 110) assetDone.resolve();
  });
  const postfloors: number[] = [];
  let simulated = false;
  const fetcher: typeof fetch = async (url, init) => {
    const request = fixtureBody(init);
    const response = await x.fetcher(url, init);
    if (Array.isArray(request)) simulated = true;
    if (request.id === 'jito-assets:after')
      return new Response(
        (await response.text()).replace('"slot":102', '"slot":110'),
      );
    if (
      simulated &&
      request.method === 'getMultipleAccounts' &&
      x.e.lookupAccounts.some((table) =>
        request.params[0].includes(table.address),
      )
    ) {
      postfloors.push(request.params[1].minContextSlot);
      if (postfloors.length === 1) {
        // Finish the unrelated slot110 asset branch before allowing ALT104.
        // A global-floor regression would therefore send the second ALT at110.
        await assetDone.promise;
        await new Promise<void>((done) => setImmediate(done));
      }
      let body = (await response.text()).replace(
        /"slot":\d+/,
        '"slot":' +
          (postfloors.length === 1
            ? 104
            : failure === 'stale-second'
              ? 103
              : 105),
      );
      if (postfloors.length === 2 && failure === 'changed-second') {
        const original = x.e.lookupAccounts[1].account.data[0];
        const bytes = Buffer.from(original, 'base64');
        bytes[56] ^= 1;
        body = body.replace(original, bytes.toString('base64'));
      }
      return new Response(body);
    }
    return response;
  };
  return { ...x, fetcher, postfloors };
}
it('chains two postflight ALT reads from their own observations rather than a later asset sibling', async () => {
  const x = await multiLookupFixture();
  expect(x.capsules).toHaveLength(2);
  expect(x.capsules[0]).not.toBe(x.capsules[1]);
  expect(x.e.manifest.swaps[0].sha256).not.toBe(x.e.manifest.swaps[1].sha256);
  expect(x.e.lookupAccounts).toHaveLength(2);
  expect(x.e.lookupAccounts[0].address).not.toBe(x.e.lookupAccounts[1].address);
  const result = await collectJitoReadOnlyQualification(
    x.e.manifest,
    x.capsules,
    new AbortController().signal,
    { fetcher: x.fetcher, pace: async () => {} },
  );
  expect(result).toMatchObject({
    status: 'checks-passed',
    minimumSlot: 100,
    maximumSlot: 110,
    fullProviderQualification: false,
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(x.postfloors).toEqual([101, 104]);
  expect(result.evidence.assetsAfter).toMatchObject({ slot: 110 });
  if (result.status === 'checks-passed') {
    expect(result.economic.frameEconomicChecksPassed).toBe(true);
    expect(result.economic.outcomes).toHaveLength(2);
    expect(result.runtimeProof).toHaveProperty('fixtureOnly', true);
  }
  expect(doubles.check).toHaveBeenCalledOnce();
  expect(
    x.methods.filter((method) => method === 'getGenesisHash'),
  ).toHaveLength(2);
});
for (const failure of ['stale-second', 'changed-second'] as const)
  it(`refuses a ${failure} ALT observation in a two-swap composition without final replay`, async () => {
    const x = await multiLookupFixture(failure);
    const result = await collectJitoReadOnlyQualification(
      x.e.manifest,
      x.capsules,
      new AbortController().signal,
      { fetcher: x.fetcher, pace: async () => {} },
    );
    expect(result).toMatchObject({
      status: 'refused',
      stage: 'lookup-after',
      minimumSlot: 100,
      maximumSlot: 110,
      fullProviderQualification: false,
      signingAllowed: false,
      executionAllowed: false,
    });
    expect(x.postfloors).toEqual([101, 104]);
    expect(result.evidence.assetsAfter).toMatchObject({ slot: 110 });
    expect(result.evidence.attempt).toMatchObject({ status: 'captured' });
    expect(doubles.check).not.toHaveBeenCalled();
    expect(
      x.methods.filter((method) => method === 'getGenesisHash'),
    ).toHaveLength(1);
  });
it('records detached monotonic stage timing without extra requests or runtime authority', async () => {
  const x = await fixture();
  let now = 10000.125;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
    const value = now;
    now += 0.25;
    return value;
  });
  try {
    const result = await collectJitoReadOnlyQualification(
      x.e.manifest,
      [x.capsule],
      new AbortController().signal,
      { fetcher: x.fetcher, pace: async () => {} },
    );
    expect(result.status).toBe('checks-passed');
    expect(result).toMatchObject({
      minimumSlot: 100,
      fullProviderQualification: false,
      sourceCurrent: false,
      runtimePrivilegesVerified: false,
      runtimeAttested: false,
      signatureVerified: false,
      signingAllowed: false,
      executionAllowed: false,
      receiptVerified: false,
    });
    const timing = result.evidence.timing;
    expect(timing).toMatchObject({
      clock: 'process-monotonic',
      originMs: 10000.125,
      diagnosticOnly: true,
      originalMinimumSlot: 100,
      maximumCapturedContextSlot: 102,
      contextSlotsAdmitted: false,
    });
    expect(
      timing.events.every(
        (event, index, events) =>
          Number.isFinite(event.atMs) &&
          event.atMs >= 0 &&
          (index === 0 || event.atMs >= events[index - 1].atMs),
      ),
    ).toBe(true);
    expect(timing.events.some((event) => !Number.isInteger(event.atMs))).toBe(
      true,
    );
    const position = (phase: string, event: string) => {
      const index = timing.events.findIndex(
        (value) => value.phase === phase && value.event === event,
      );
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };
    for (const phase of [
      'collector',
      'manifest-validation',
      'baseline-replay',
      'network',
      'lookup-before',
      'packet-scope',
      'assets-before',
      'runtime-before',
      'exact-simulation',
      'assets-after',
      'lookup-after',
      'runtime-after',
      'final-genesis',
      'asset-runtime-replay',
      'economic-replay',
    ])
      expect(position(phase, 'finish')).toBeGreaterThan(
        position(phase, 'begin'),
      );
    expect(position('baseline-replay', 'begin')).toBeGreaterThan(
      position('manifest-validation', 'finish'),
    );
    expect(position('network', 'begin')).toBeGreaterThan(
      position('baseline-replay', 'finish'),
    );
    expect(position('exact-simulation', 'begin')).toBeGreaterThan(
      position('assets-before', 'finish'),
    );
    expect(position('exact-simulation', 'begin')).toBeGreaterThan(
      position('runtime-before', 'finish'),
    );
    expect(position('runtime-after', 'begin')).toBeGreaterThan(
      position('exact-simulation', 'finish'),
    );
    for (const phase of ['assets-after', 'lookup-after', 'runtime-after'])
      expect(position('final-genesis', 'begin')).toBeGreaterThan(
        position(phase, 'finish'),
      );
    expect(position('asset-runtime-replay', 'begin')).toBeGreaterThan(
      position('final-genesis', 'finish'),
    );
    expect(position('economic-replay', 'begin')).toBeGreaterThan(
      position('asset-runtime-replay', 'finish'),
    );
    expect(timing.events.at(-1)).toMatchObject({
      phase: 'collector',
      event: 'finish',
    });
    expect(x.methods).toEqual([
      'getGenesisHash',
      'getMultipleAccounts',
      'simulateBundle',
      'batch',
      'getMultipleAccounts',
      'getGenesisHash',
    ]);
    expect(doubles.scans).toHaveBeenCalledTimes(2);
    expect(doubles.check).toHaveBeenCalledOnce();
    for (const transport of result.evidence.transports) {
      expect(transport.summary.timing.originMs).toBeGreaterThanOrEqual(
        timing.originMs,
      );
      for (const capture of transport.captures)
        expect(
          transport.summary.timing.originMs + capture.timing.queuedAtMs,
        ).toBeGreaterThanOrEqual(timing.originMs);
    }
  } finally {
    clock.mockRestore();
  }
});
it('retains failed-branch timing without starting simulation or a second scan', async () => {
  const x = await fixture();
  let now = 20000.125;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now++);
  doubles.scans.mockImplementationOnce(async () => {
    now += 25;
    throw Error('Controlled runtime refusal');
  });
  try {
    const result = await collectJitoReadOnlyQualification(
      x.e.manifest,
      [x.capsule],
      new AbortController().signal,
      { fetcher: x.fetcher, pace: async () => {} },
    );
    expect(result).toMatchObject({
      status: 'refused',
      stage: 'runtime-before',
      minimumSlot: 100,
      fullProviderQualification: false,
      signingAllowed: false,
      executionAllowed: false,
    });
    const timing = result.evidence.timing;
    const begin = timing.events.find(
      (e) => e.phase === 'runtime-before' && e.event === 'begin',
    );
    const refused = timing.events.find(
      (e) => e.phase === 'runtime-before' && e.event === 'refused',
    );
    expect(begin).toBeDefined();
    expect(refused).toBeDefined();
    expect(refused!.atMs - begin!.atMs).toBeGreaterThanOrEqual(25);
    expect(timing).toMatchObject({
      originMs: 20000.125,
      originalMinimumSlot: 100,
      diagnosticOnly: true,
      contextSlotsAdmitted: false,
    });
    expect(timing.events.at(-1)).toMatchObject({
      phase: 'collector',
      event: 'refused',
    });
    expect(
      timing.events.some(
        (e) =>
          e.phase === 'exact-simulation' ||
          e.phase === 'runtime-after' ||
          e.phase === 'economic-replay',
      ),
    ).toBe(false);
    expect(x.methods).not.toContain('batch');
    expect(doubles.scans).toHaveBeenCalledOnce();
    expect(doubles.check).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});

it.each(['final-genesis', 'asset-runtime-replay'] as const)(
  'records the actual open timing phase on %s refusal',
  async (phase) => {
    const x = await fixture();
    let genesisReads = 0;
    if (phase === 'asset-runtime-replay')
      doubles.check.mockRejectedValue(Error('Controlled replay refusal'));
    const fetcher: typeof fetch = async (url, init) => {
      const request = fixtureBody(init);
      if (
        request.method === 'getGenesisHash' &&
        ++genesisReads === 2 &&
        phase === 'final-genesis'
      )
        return Response.json({
          jsonrpc: '2.0',
          id: request.id,
          result: 'wrong-genesis',
        });
      return x.fetcher(url, init);
    };
    const result = await collectJitoReadOnlyQualification(
      x.e.manifest,
      [x.capsule],
      new AbortController().signal,
      { fetcher, pace: async () => {} },
    );
    expect(result.status).toBe('refused');
    expect(
      result.evidence.timing.events
        .filter((e) => e.phase === 'collector')
        .map((e) => e.event),
    ).toEqual(['begin', 'refused']);
    expect(
      result.evidence.timing.events
        .filter((e) => e.phase === phase)
        .map((e) => e.event),
    ).toEqual(['begin', 'refused']);
    expect(
      result.evidence.timing.events.some((e) => e.phase === 'economic-replay'),
    ).toBe(false);
    expect(doubles.scans).toHaveBeenCalledTimes(2);
    expect(result.signingAllowed).toBe(false);
    expect(result.executionAllowed).toBe(false);
  },
);
