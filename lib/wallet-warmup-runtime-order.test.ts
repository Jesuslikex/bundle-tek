import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/server-env', () => ({
  env: {
    SOLANA_INDEXER_RPC_URL: 'https://warmup-runtime.fixture.example/',
    SOLANA_MAINNET_RPC_URL: 'https://warmup-runtime.fixture.example/',
  },
}));
afterEach(() => vi.unstubAllGlobals());
import { setImmediate as nextTurn } from 'node:timers';
import { warmupRuntimeOrderFixture } from '@/test/warmup-runtime-order-fixture';
import {
  collectWalletWarmupRuntimeOrder,
  walletWarmupRuntimeOrderRequestDigest,
} from './wallet-warmup-runtime-order';
import { warmupPreparationSummary } from './warmup-preparation-history';
import { createStockPairEvidenceRpc } from './pair-stock-clock';
import { WalletRpcError } from './wallet-balances';
import { warmupV2AttemptProviderFixture } from '@/test/warmup-session-v2-attempt-provider-fixture';
import { createWalletWarmupV2Provider } from './wallet-warmup-session-v2-provider';
import {
  prepareWalletWarmupV2Attempt,
  publicWalletWarmupV2Attempt,
} from './wallet-warmup-session-v2-attempts';

for (const options of [
  { side: 'Buy' as const },
  { side: 'Sell' as const },
  { side: 'Buy' as const, lookup: true },
  { side: 'Sell' as const, v2: true, token2022: true },
  { side: 'Sell' as const, existing: true },
  { side: 'Buy' as const, keepWrapped: true },
])
  it(`collects actual raw unsigned runtime evidence for ${JSON.stringify(options)}`, async () => {
    const f = await warmupRuntimeOrderFixture(options);
    const request = structuredClone(f.request);
    const result = await collectWalletWarmupRuntimeOrder(
      f.request,
      f.dependencies,
    );
    expect(f.request).toEqual(request);
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(
      f.rpc.mock.calls.filter(([method]) => method === 'simulateTransaction'),
    ).toHaveLength(1);
    expect(result.runtime.codeScans).toHaveLength(2);
    expect(result.runtime.codeScans[0]).toEqual(result.runtime.codeScans[1]);
    expect(result.observation).toMatchObject({
      referenceMinimum: 'order-self',
      independentPriceProtectionEstablished: false,
      codeReadConcurrency: 1,
      programCodeAttested: false,
      trustedProgramPolicyEstablished: false,
      signingAllowed: false,
      executionAllowed: false,
    });
    expect(
      result.observation.maximumSlot - result.observation.minimumSlot,
    ).toBeLessThanOrEqual(32);
    expect(result.simulation).not.toHaveProperty('settlementEvidence');
    expect(result.simulation).not.toHaveProperty('lookupObservation');
    expect(result.simulation.nativeChangeRaw).toBe(
      (BigInt(f.receipt.meta.postBalances[0]) - 100000000n).toString(),
    );
    const nativeIndex = options.side === 'Buy' ? 0 : 1,
      wrapped = result.simulation.tokenChanges.find(
        (t) => t.mint === 'So11111111111111111111111111111111111111112',
      )!,
      beforeWrapped = f.first[nativeIndex]
        ? Buffer.from(f.first[nativeIndex]!.data[0], 'base64').readBigUInt64LE(
            64,
          )
        : 0n,
      afterWrapped = f.last[nativeIndex]
        ? Buffer.from(f.last[nativeIndex]!.data[0], 'base64').readBigUInt64LE(
            64,
          )
        : 0n;
    expect([wrapped.beforeRaw, wrapped.afterRaw, wrapped.changeRaw]).toEqual([
      beforeWrapped.toString(),
      afterWrapped.toString(),
      (afterWrapped - beforeWrapped).toString(),
    ]);
    const token = result.simulation.tokenChanges.find(
      (t) => t.mint === f.mint,
    )!;
    expect([token.beforeRaw, token.afterRaw, token.changeRaw]).toEqual(
      options.side === 'Buy' ? ['0', '1000', '1000'] : ['1000', '0', '-1000'],
    );
    expect(result.observation.nativeSettlement.nativeTradeDeltaRaw).toBe(
      options.side === 'Buy' ? '-1000000' : '1000000',
    );
    expect(result.observation.clockObservations.length).toBeGreaterThan(0);
    expect(
      result.observation.clockObservations.every(
        (c) => c.channel === 'account',
      ),
    ).toBe(true);
    expect(result.observation.codeClockPolicy).toBe('context-slot-floor-only');
    const summary = warmupPreparationSummary(
      result.order,
      result.simulation,
      f.mint,
      f.request.inventory ?? undefined,
    );
    expect(summary.simulation.succeeded).toBe(true);
    expect(summary.instructionsVerified).toBe(false);
    expect(summary.executionAllowed).toBe(false);
    expect(result.context.quote.pair).not.toHaveProperty('projectId');
    expect(
      result.observation.observations.some((r) => r.channel === 'code'),
    ).toBe(true);
    expect(
      f.rpc.mock.calls.every(
        ([method]) => !['sendTransaction', 'requestAirdrop'].includes(method),
      ),
    ).toBe(true);
  });

it('refuses a stock-scoped account or program channel before any read or order', async () => {
  for (const channel of ['rpc', 'programRpc'] as const) {
    const f = await warmupRuntimeOrderFixture(),
      scope = createStockPairEvidenceRpc(f.rpc, f.rpc, f.dependencies.now);
    f.dependencies[channel] = scope.rpc;
    await expect(
      collectWalletWarmupRuntimeOrder(f.request, f.dependencies),
    ).rejects.toThrow('Warmup runtime observations');
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.rpc).not.toHaveBeenCalled();
  }
});
for (const offset of [-1, 1, 2])
  it(`refuses ordinary Clock/context offset ${offset} before ordering`, async () => {
    const f = await warmupRuntimeOrderFixture();
    f.state.clockDelta = offset;
    await expect(
      collectWalletWarmupRuntimeOrder(f.request, f.dependencies),
    ).rejects.toThrow('Pair chain clock is inconsistent or stale');
    expect(f.prepare).not.toHaveBeenCalled();
  });
it('refuses a real wallet change during the order rather than weakening custody', async () => {
  const f = await warmupRuntimeOrderFixture();
  f.state.onPrepare = () => {
    (f.accounts.get(f.wallet) as { lamports: string }).lamports = '99999999';
  };
  await expect(
    collectWalletWarmupRuntimeOrder(f.request, f.dependencies),
  ).rejects.toThrow('Selected wallet balances');
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(
    f.rpc.mock.calls.some(([method]) => method === 'simulateTransaction'),
  ).toBe(false);
});
it('refuses underestimated rent without modifying the quote or original reserve', async () => {
  const f = await warmupRuntimeOrderFixture();
  f.order.preparation.estimates.rentFeeLamports = '0';
  f.order.preparation.estimatedFeesLamports = '5000';
  const before = structuredClone(f.order);
  await expect(
    collectWalletWarmupRuntimeOrder(f.request, f.dependencies),
  ).rejects.toThrow('Warmup runtime observations');
  expect(f.order).toEqual(before);
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(
    f.rpc.mock.calls.filter(([method]) => method === 'simulateTransaction'),
  ).toHaveLength(1);
});
it('refuses raw post-state that spends too much SOL', async () => {
  const f = await warmupRuntimeOrderFixture();
  f.state.onSimulation = (value, addresses) => {
    const wallet = value.accounts[addresses.indexOf(f.wallet)] as {
      lamports: string;
    };
    wallet.lamports = (BigInt(wallet.lamports) - 1n).toString();
  };
  await expect(
    collectWalletWarmupRuntimeOrder(f.request, f.dependencies),
  ).rejects.toThrow('SOL spending');
  expect(f.prepare).toHaveBeenCalledOnce();
});
it('keeps the original deadline across the order and performs no simulation after expiry', async () => {
  const f = await warmupRuntimeOrderFixture();
  f.state.onPrepare = () => {
    f.clock.now += 25000;
  };
  await expect(
    collectWalletWarmupRuntimeOrder(f.request, f.dependencies),
  ).rejects.toThrow('Warmup runtime observations');
  expect(
    f.rpc.mock.calls.some(([method]) => method === 'simulateTransaction'),
  ).toBe(false);
  expect(f.request.deadline).toBeGreaterThan(f.clock.now);
});

for (const span of [32, 33])
  it(`uses every read including pre-order evidence in the ${span}-slot window`, async () => {
    const f = await warmupRuntimeOrderFixture();
    f.state.onPrepare = () => {
      f.state.slot = 100 + span;
    };
    const run = collectWalletWarmupRuntimeOrder(f.request, f.dependencies);
    if (span === 32) {
      const result = await run;
      expect(
        result.observation.maximumSlot - result.observation.minimumSlot,
      ).toBe(32);
      expect(result.observation.minimumSlot).toBe(100);
      expect(result.observation.maximumSlot).toBe(132);
    } else {
      await expect(run).rejects.toThrow('too many slots');
      expect(
        f.rpc.mock.calls.some(([method]) => method === 'simulateTransaction'),
      ).toBe(false);
    }
    expect(f.prepare).toHaveBeenCalledOnce();
  });
it('detects a changed complete code observation after simulation', async () => {
  const f = await warmupRuntimeOrderFixture();
  f.state.onSimulation = () => {
    const program = [...f.programs.values()].find((p) =>
      p.owner.startsWith('BPFLoader'),
    )!;
    const bytes = Buffer.from(program.data[0], 'base64');
    bytes[20] ^= 1;
    program.data[0] = bytes.toString('base64');
  };
  await expect(
    collectWalletWarmupRuntimeOrder(f.request, f.dependencies),
  ).rejects.toThrow('program code or upgrade authority changed');
  expect(
    f.rpc.mock.calls.filter(([method]) => method === 'simulateTransaction'),
  ).toHaveLength(1);
});
it('really serializes both complete large-code observations', async () => {
  const f = await warmupRuntimeOrderFixture();
  for (const program of f.programs.values())
    if (program.owner.startsWith('BPFLoader')) {
      const bytes = Buffer.alloc(800000);
      bytes.set([127, 69, 76, 70, 1]);
      program.data[0] = bytes.toString('base64');
      program.space = String(bytes.length);
    }
  const source = f.rpc.getMockImplementation()!;
  let active = 0,
    peak = 0,
    bodies = 0;
  f.rpc.mockImplementation(async (method, params) => {
    const body =
      method === 'getMultipleAccounts' &&
      ((params[1] as { dataSlice?: { length: number } })?.dataSlice?.length ??
        0) > 166;
    if (body) {
      bodies++;
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => nextTurn(resolve));
    }
    try {
      return await source(method, params);
    } finally {
      if (body) active--;
    }
  });
  const result = await collectWalletWarmupRuntimeOrder(
    f.request,
    f.dependencies,
  );
  expect(peak).toBe(1);
  expect(bodies).toBeGreaterThan(4);
  expect(result.runtime.codeScans[0]).toEqual(result.runtime.codeScans[1]);
});
it('refuses an undersized output directly from raw post-account bytes', async () => {
  const f = await warmupRuntimeOrderFixture();
  f.state.onSimulation = (value, addresses) => {
    const token = addresses.findIndex(
      (key) =>
        key !== f.wallet &&
        f.accounts.get(key) === null &&
        value.accounts[addresses.indexOf(key)] !== null,
    );
    const a = value.accounts[token] as { data: string[] };
    const bytes = Buffer.from(a.data[0], 'base64');
    bytes.writeBigUInt64LE(994n, 64);
    a.data[0] = bytes.toString('base64');
  };
  await expect(
    collectWalletWarmupRuntimeOrder(f.request, f.dependencies),
  ).rejects.toThrow('token spending or output protection differs');
});
it('aborts a held order and refuses late simulation or publication', async () => {
  const f = await warmupRuntimeOrderFixture(),
    controller = new AbortController();
  f.dependencies.signal = controller.signal;
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  f.prepare.mockImplementation(async () => {
    entered();
    await hold;
    return structuredClone(f.order);
  });
  const run = collectWalletWarmupRuntimeOrder(f.request, f.dependencies);
  await started;
  controller.abort();
  release();
  await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  expect(
    f.rpc.mock.calls.some(([method]) => method === 'simulateTransaction'),
  ).toBe(false);
});

it('refuses a Sell inventory span beyond32 before starting parallel reads', async () => {
  const f = await warmupRuntimeOrderFixture({ side: 'Sell' });
  f.request.inventory!.maxSlot = 133;
  f.request.requestSha256 = await walletWarmupRuntimeOrderRequestDigest(
    f.request,
  );
  await expect(
    collectWalletWarmupRuntimeOrder(f.request, f.dependencies),
  ).rejects.toThrow();
  expect(f.rpc).not.toHaveBeenCalled();
  expect(f.prepare).not.toHaveBeenCalled();
});
it('never extends the original Sell inventory expiry', async () => {
  const f = await warmupRuntimeOrderFixture({ side: 'Sell' });
  f.request.inventory!.expiresAt = new Date(f.clock.now + 1000).toISOString();
  f.request.requestSha256 = await walletWarmupRuntimeOrderRequestDigest(
    f.request,
  );
  f.state.onPrepare = () => {
    f.clock.now += 1000;
  };
  await expect(
    collectWalletWarmupRuntimeOrder(f.request, f.dependencies),
  ).rejects.toThrow('Warmup runtime observations');
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(
    f.rpc.mock.calls.some(([method]) => method === 'simulateTransaction'),
  ).toBe(false);
});
it('does not retry an account-provider429 or start an order', async () => {
  const f = await warmupRuntimeOrderFixture(),
    read = f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async (method, params) => {
    if (method === 'getSlot') throw new WalletRpcError(429);
    return read(method, params);
  });
  await expect(
    collectWalletWarmupRuntimeOrder(f.request, f.dependencies),
  ).rejects.toMatchObject({ status: 429 });
  expect(
    f.rpc.mock.calls.filter(([method]) => method === 'getSlot'),
  ).toHaveLength(1);
  expect(f.prepare).not.toHaveBeenCalled();
});

it('composes the default Jupiter parser and bounded HTTP RPC transports with one order and raw simulation', async () => {
  const f = await warmupRuntimeOrderFixture();
  for (const program of f.programs.values())
    if (program.owner.startsWith('BPFLoader')) {
      const bytes = Buffer.alloc(800000);
      bytes.set([127, 69, 76, 70, 1]);
      program.data[0] = bytes.toString('base64');
      program.space = String(bytes.length);
    }
  let orders = 0,
    largeCodeResponses = 0;
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(url instanceof Request ? url.url : url);
    if (
      target.origin + target.pathname ===
      'https://api.jup.ag/swap/v2/order'
    ) {
      orders++;
      expect(target.searchParams.get('taker')).toBe(f.wallet);
      expect(target.searchParams.get('amount')).toBe(f.order.inAmount);
      return Response.json({
        inputMint: f.order.inputMint,
        outputMint: f.order.outputMint,
        inAmount: f.order.inAmount,
        outAmount: f.order.outAmount,
        otherAmountThreshold: f.order.minimumOutAmount,
        swapMode: 'ExactIn',
        slippageBps: 50,
        router: 'metis',
        taker: f.wallet,
        gasless: false,
        transactionVersion: 0,
        transaction: f.order.preparation.transaction,
        lastValidBlockHeight: '1100',
        signatureFeeLamports: 5000,
        signatureFeePayer: f.wallet,
        prioritizationFeeLamports: 0,
        prioritizationFeePayer: null,
        rentFeeLamports: Number(f.order.preparation.estimates.rentFeeLamports),
        rentFeePayer: f.wallet,
      });
    }
    expect(target.href).toBe('https://warmup-runtime.fixture.example/');
    expect(init?.method).toBe('POST');
    if (typeof init?.body !== 'string')
      throw Error('Expected synthetic JSON RPC body');
    const body = JSON.parse(init.body) as {
      method: string;
      params: unknown[];
    };
    // The blockhash refresh rides the plain fetch defaults; the evidence
    // transports are the ones that must pin redirect, cache and signal.
    if (body.method !== 'getLatestBlockhash') {
      expect(init?.redirect).toBe('manual');
      expect(init?.cache).toBe('no-store');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    const result = await f.rpc(body.method, body.params),
      response = Response.json({ jsonrpc: '2.0', id: 1, result });
    if (Number(response.headers.get('content-length') ?? 0) > 524288)
      largeCodeResponses++;
    if ((await response.clone().text()).length > 524288) largeCodeResponses++;
    return response;
  });
  vi.stubGlobal('fetch', fetcher);
  const {
    rpc: _rpc,
    programRpc: _code,
    prepare: _prepare,
    ...dependencies
  } = f.dependencies;
  const result = await collectWalletWarmupRuntimeOrder(f.request, dependencies);
  expect(orders).toBe(1);
  expect(f.prepare).not.toHaveBeenCalled();
  expect(largeCodeResponses).toBeGreaterThan(0);
  expect(
    f.rpc.mock.calls.filter(([method]) => method === 'simulateTransaction'),
  ).toHaveLength(1);
  expect(result.observation.signingAllowed).toBe(false);
  expect(result.runtime.codeScans[0]).toEqual(result.runtime.codeScans[1]);
}, 15000);

it('enforces the ordinary HTTP response cap before parsing an oversized reply', async () => {
  const f = await warmupRuntimeOrderFixture();
  let slots = 0;
  vi.stubGlobal(
    'fetch',
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== 'string')
        throw Error('Expected synthetic JSON RPC body');
      const body = JSON.parse(init.body) as {
        method: string;
        params: unknown[];
      };
      if (body.method === 'getSlot') {
        slots++;
        return new Response(' '.repeat(524289));
      }
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: await f.rpc(body.method, body.params),
      });
    },
  );
  const { rpc: _rpc, programRpc: _code, ...dependencies } = f.dependencies;
  await expect(
    collectWalletWarmupRuntimeOrder(f.request, dependencies),
  ).rejects.toThrow('Balance response too large');
  expect(slots).toBe(1);
  expect(f.prepare).not.toHaveBeenCalled();
});

it('preserves the existing refusal of a prefunded native input without the required wrapping', async () => {
  const f = await warmupRuntimeOrderFixture({ side: 'Buy', existing: true });
  await expect(
    collectWalletWarmupRuntimeOrder(f.request, f.dependencies),
  ).rejects.toMatchObject({
    pairDiagnostic: { check: 'native-input-funding' },
  });
  expect(
    f.rpc.mock.calls.some(([method]) => method === 'simulateTransaction'),
  ).toBe(false);
});
for (const field of [
  'wallet',
  'mint',
  'inputRaw',
  'feeAndRentLimitRaw',
  'deadline',
] as const)
  it(`refuses a stale request digest after ${field} changes, before any read`, async () => {
    const f = await warmupRuntimeOrderFixture();
    if (field === 'deadline') f.request.deadline++;
    else
      f.request[field] =
        field === 'wallet' ? f.mint : field === 'mint' ? f.wallet : '999999';
    await expect(
      collectWalletWarmupRuntimeOrder(f.request, f.dependencies),
    ).rejects.toThrow('Warmup runtime observations');
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
  });
for (const change of ['program', 'available', 'observed-at'] as const)
  it(`refuses contradictory Sell inventory ${change} even with a valid read digest`, async () => {
    const f = await warmupRuntimeOrderFixture({ side: 'Sell' }),
      inventory = f.request.inventory!;
    if (change === 'program')
      inventory.tokenProgram = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
    if (change === 'available') {
      inventory.unfrozenRaw = '1';
      inventory.totalRaw = '1';
    }
    if (change === 'observed-at')
      inventory.observedAt = new Date(f.clock.now - 60001).toISOString();
    f.request.requestSha256 = await walletWarmupRuntimeOrderRequestDigest(
      f.request,
    );
    await expect(
      collectWalletWarmupRuntimeOrder(f.request, f.dependencies),
    ).rejects.toThrow('Warmup runtime observations');
    expect(f.prepare).not.toHaveBeenCalled();
    if (change !== 'program') expect(f.rpc).not.toHaveBeenCalled();
  });
it('keeps an earlier original deadline rather than renewing it to25seconds', async () => {
  const f = await warmupRuntimeOrderFixture();
  f.request.deadline = f.clock.now + 1000;
  f.request.requestSha256 = await walletWarmupRuntimeOrderRequestDigest(
    f.request,
  );
  f.state.onPrepare = () => {
    f.clock.now += 1000;
  };
  await expect(
    collectWalletWarmupRuntimeOrder(f.request, f.dependencies),
  ).rejects.toThrow('Warmup runtime observations');
  expect(
    f.rpc.mock.calls.some(([method]) => method === 'simulateTransaction'),
  ).toBe(false);
});
it('refuses an already cancelled request before provider reads', async () => {
  const f = await warmupRuntimeOrderFixture(),
    controller = new AbortController();
  controller.abort();
  f.dependencies.signal = controller.signal;
  await expect(
    collectWalletWarmupRuntimeOrder(f.request, f.dependencies),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.rpc).not.toHaveBeenCalled();
  expect(f.prepare).not.toHaveBeenCalled();
});
for (const channel of ['rpc', 'programRpc'] as const)
  it(`requires both explicit channels rather than silently substituting a transport (${channel})`, async () => {
    const f = await warmupRuntimeOrderFixture();
    delete f.dependencies[channel];
    await expect(
      collectWalletWarmupRuntimeOrder(f.request, f.dependencies),
    ).rejects.toThrow('Warmup runtime observations');
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
  });

it('passes the raw projection through the real provider budget guards without promoting a saved preview to runtime authority', async () => {
  // Synthetic internal injection only. Production requires the separate runtime
  // purpose/consent and atomic sidecar; no application route selects this adapter.
  const stored = await warmupV2AttemptProviderFixture();
  try {
    const f = await warmupRuntimeOrderFixture({ mint: stored.packets.mint });
    expect(f.wallet).toBe(stored.packets.wallet);
    const { previewRequested: _approval, ...input } = stored.input();
    let runtime:
      | Awaited<ReturnType<typeof collectWalletWarmupRuntimeOrder>>
      | undefined;
    let simulations = 0;
    const saved = await prepareWalletWarmupV2Attempt(
      stored.db,
      'owner',
      input,
      true,
      new AbortController().signal,
      'synthetic-key',
      (db, owner, key, lease) =>
        createWalletWarmupV2Provider(db, owner, key, lease, {
          quote: async (request, _key, signal) => {
            expect(request).toMatchObject({
              wallet: f.wallet,
              tokenMint: f.mint,
              side: 'Buy',
              amount: '0.001',
            });
            f.request.deadline = Date.parse(lease.expires_at);
            f.request.requestSha256 =
              await walletWarmupRuntimeOrderRequestDigest(f.request);
            runtime = await collectWalletWarmupRuntimeOrder(f.request, {
              ...f.dependencies,
              signal,
            });
            return runtime.order;
          },
          simulate: async (order) => {
            simulations++;
            expect(runtime).toBeDefined();
            expect(order.preparation.sha256).toBe(
              runtime!.order.preparation.sha256,
            );
            return runtime!.simulation;
          },
        }),
    );
    expect(saved.outcome?.kind).toBe('prepared');
    expect(saved.summary?.simulation.nativeChangeRaw).toBe(
      runtime!.simulation.nativeChangeRaw,
    );
    expect(saved.summary?.simulation.networkFeeLamports).toBe('5000');
    expect(saved.fee).toEqual({
      ...runtime!.order.preparation.estimates,
      observedNetworkFeeLamports: '5000',
      boundLamports: (
        5000n + BigInt(runtime!.order.preparation.estimates.rentFeeLamports)
      ).toString(),
    });
    expect(simulations).toBe(1);
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(
      f.rpc.mock.calls.filter(([method]) => method === 'simulateTransaction'),
    ).toHaveLength(1);
    const published = publicWalletWarmupV2Attempt(saved);
    expect(published).toMatchObject({
      signingAllowed: false,
      executionAllowed: false,
      automaticExecutionAllowed: false,
      instructionsVerified: false,
    });
    expect(published).not.toHaveProperty('runtime');
    expect(published).not.toHaveProperty('codeScans');
  } finally {
    stored.client.close();
  }
});
