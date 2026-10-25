import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  getBase64Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  address,
  type SignatureBytes,
} from '@solana/kit';
import nacl from 'tweetnacl';
import { jitoRawResponseFixture } from '../test/jito-raw-response-fixture';
import { jitoDatabase } from '../test/jito-sqlite';
import { tradeSessionTerms } from './imported-trade-session';
import { unsignedPreparationSummary } from './imported-swap-preparation-history';
import { bundleFingerprint } from './jito-bundle';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { registerJitoPacket } from './jito-bundle-server';
import { checkJitoBundleSequential } from './jito-sequential-check-server';
import { env } from './server-env';
import { env as providerEnv } from '@/lib/server-env';
const originalHolder = providerEnv.SOLANA_HOLDER_RPC_URL;

const databases: ReturnType<typeof jitoDatabase>[] = [];
afterEach(() => {
  for (const d of databases.splice(0)) d.sqlite.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (originalHolder === undefined) delete providerEnv.SOLANA_HOLDER_RPC_URL;
  else providerEnv.SOLANA_HOLDER_RPC_URL = originalHolder;
});
async function setup(
  options: {
    side?: 'Buy' | 'Sell';
    lookup?: boolean;
    token2022?: boolean;
    wallets?: number;
    savedFeeSlot?: number;
  } = {},
) {
  const f = await jitoRawResponseFixture(options),
    manifest = f.fixture.manifest;
  const first = f.fixture.observations[0].order;
  const mint = first.side === 'Buy' ? first.outputMint : first.inputMint;
  const terms = tradeSessionTerms(
    {
      projectId: manifest.projectId,
      projectRevision: 1,
      side: first.side,
      entries: manifest.swaps.map((r) => ({
        wallet: r.wallet,
        walletRevision: 1,
        amount: '0.001',
      })),
    },
    { chain: 'Solana', address: mint, decimals: 6 },
  );
  const document = JSON.stringify(terms),
    termsSha256 = createHash('sha256').update(document).digest('hex');
  for (const [i, r] of manifest.swaps.entries())
    r.session = {
      format: 'trade-session-entry-v1',
      sessionId: manifest.sessionId,
      sessionRevision: 1,
      entry: i + 1,
      unitsRaw: r.inputRaw,
      termsSha256,
    };
  manifest.sha256 = await bundleFingerprint(
    (({ sha256: _digest, ...rest }) => rest)(manifest),
  );
  const d = jitoDatabase(manifest);
  databases.push(d);
  d.sqlite.exec(
    'ALTER TABLE imported_token_projects ADD COLUMN document TEXT; ALTER TABLE imported_trade_sessions ADD COLUMN created_at TEXT; ALTER TABLE imported_trade_sessions ADD COLUMN updated_at TEXT;',
  );
  d.sqlite
    .prepare('UPDATE imported_token_projects SET address=?,document=?')
    .run(mint, JSON.stringify({ token: { address: mint, decimals: 6 } }));
  d.sqlite
    .prepare(
      'UPDATE imported_trade_sessions SET document=?,created_at=?,updated_at=?',
    )
    .run(document, manifest.createdAt, manifest.createdAt);
  for (const [i, r] of manifest.swaps.entries()) {
    const summary = unsignedPreparationSummary(
      f.fixture.observations[i].order,
      f.fixture.observations[i].simulation,
    );
    if (options.savedFeeSlot !== undefined)
      summary.simulation.feeSlot = options.savedFeeSlot;
    d.sqlite
      .prepare('UPDATE imported_swap_preparations SET document=? WHERE id=?')
      .run(JSON.stringify({ ...summary, session: r.session }), r.preparationId);
  }
  d.attach();
  const calls: string[] = [],
    methodCounts: number[] = [],
    pace = vi.fn(async (_endpoint: string, _signal: AbortSignal) => {});
  let hook: ((method: string) => void | Promise<void>) | undefined;
  let feeStatus = 200,
    simulationStatus = 200,
    lookupDrift = false,
    simulationSeen = false;
  let supportSlot = 101n,
    feeSlot = 101n,
    supportAfterSlot = 101n,
    discoverySlot = 101n;
  let discoveryStatus = 200,
    batchStatus = 200;
  let finalGenesis = SOLANA_MAINNET_GENESIS;
  const fetcher: typeof fetch = async (_url, init) => {
    if (typeof init?.body !== 'string')
      throw Error('Expected synthetic string body');
    const request = JSON.parse(init.body) as
      | { id: string; method: string; params: unknown[] }
      | { id: string; method: string; params: unknown[] }[];
    const mixed =
      Array.isArray(request) &&
      request.some((r) => r.method === 'simulateBundle');
    const isDiscovery =
      !Array.isArray(request) &&
      request.method === 'simulateBundle' &&
      typeof (
        request.params[1] as { simulationBank?: { commitment?: unknown } }
      )?.simulationBank?.commitment !== 'undefined';
    const method = Array.isArray(request)
      ? mixed
        ? 'coherentBatch'
        : 'fees'
      : isDiscovery
        ? 'discovery'
        : request.method;
    calls.push(method);
    methodCounts.push(Array.isArray(request) ? request.length : 1);
    await hook?.(method);
    if (Array.isArray(request)) {
      if (mixed) simulationSeen = true;
      return new Response(
        f.wire(
          request.map((r) =>
            r.method === 'simulateBundle'
              ? { ...f.envelope, id: r.id }
              : {
                  jsonrpc: '2.0',
                  id: r.id,
                  result: {
                    context: { slot: feeSlot, apiVersion: '4.3.2' },
                    value: 5000n,
                  },
                },
          ),
        ),
        { status: mixed ? batchStatus : feeStatus },
      );
    }
    if (isDiscovery)
      return new Response(
        f.wire({
          ...f.envelope,
          id: request.id,
          result: {
            ...f.envelope.result,
            context: { slot: discoverySlot, apiVersion: '4.3.2' },
          },
        }),
        { status: discoveryStatus },
      );
    if (method === 'getGenesisHash')
      return new Response(
        f.wire({
          jsonrpc: '2.0',
          id: request.id,
          result: simulationSeen ? finalGenesis : SOLANA_MAINNET_GENESIS,
        }),
      );
    if (method === 'getMultipleAccounts') {
      const values = (request.params[0] as string[]).map((key) => {
        const source = f.fixture.lookupAccounts.find(
          (a) => a.address === key,
        )?.account;
        if (!source) throw Error('Unexpected synthetic lookup');
        const data = [...source.data];
        if (lookupDrift && simulationSeen) {
          const bytes = Buffer.from(data[0], 'base64');
          bytes[56] ^= 1;
          data[0] = bytes.toString('base64');
        }
        return {
          ...source,
          data,
          lamports: BigInt(source.lamports),
          rentEpoch: (1n << 64n) - 1n,
          space: BigInt(Buffer.from(data[0], 'base64').length),
        };
      });
      return new Response(
        f.wire({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            context: { slot: simulationSeen ? supportAfterSlot : supportSlot },
            value: values,
          },
        }),
      );
    }
    if (method === 'simulateBundle') {
      simulationSeen = true;
      return new Response(f.wire({ ...f.envelope, id: request.id }), {
        status: simulationStatus,
      });
    }
    throw Error('Unexpected synthetic method');
  };
  const dependencies = { fetcher, pace };
  return {
    f,
    d,
    calls,
    methodCounts,
    pace,
    dependencies,
    input: { id: manifest.id, sha256: manifest.sha256 },
    setHook: (fn: typeof hook) => {
      hook = fn;
    },
    setStatus: (phase: 'fees' | 'simulation', status: number) => {
      if (phase === 'fees') feeStatus = status;
      else simulationStatus = status;
    },
    driftLookup: () => {
      lookupDrift = true;
    },
    setCoherentStatus: (phase: 'discovery' | 'batch', status: number) => {
      if (phase === 'discovery') discoveryStatus = status;
      else batchStatus = status;
    },
    setDiscoverySlot: (slot: bigint) => {
      discoverySlot = slot;
    },
    driftGenesis: () => {
      finalGenesis = 'wrong-genesis';
    },
    setSlots: (before: bigint, fee: bigint, after = before) => {
      supportSlot = before;
      feeSlot = fee;
      supportAfterSlot = after;
      f.envelope.result.context.slot = fee;
    },
  };
}
for (const side of ['Buy', 'Sell'] as const)
  for (const lookup of [false, true])
    for (const token2022 of [false, true])
      it(`composes actual owned SQL, fee collector and raw adapter for ${side}/ALT=${lookup}/2022=${token2022}`, async () => {
        const x = await setup({ side, lookup, token2022, wallets: 2 });
        const rowsBefore = x.d.sqlite
          .prepare('SELECT * FROM jito_bundles')
          .all();
        const result = await checkJitoBundleSequential(
          x.d.db,
          'owner',
          x.input,
          new AbortController().signal,
          x.dependencies,
        );
        expect(result).toMatchObject({
          status: 'frames-observed',
          reason: 'frame-integrity-only',
          bundleId: x.input.id,
          manifestSha256: x.input.sha256,
          minimumSlot: 100,
          simulationSlot: 101,
          packetCount: 3,
          signingAllowed: false,
          executionAllowed: false,
          economicOutputVerified: false,
          providerQualified: false,
          altStateVerified: false,
        });
        expect(result.fees).toHaveLength(3);
        expect(Object.keys(result)).not.toContain('rawResponse');
        expect(JSON.stringify(result)).not.toContain(
          x.f.fixture.manifest.swaps[0].transaction,
        );
        expect(x.d.sqlite.prepare('SELECT * FROM jito_bundles').all()).toEqual(
          rowsBefore,
        );
        expect(x.calls.filter((m) => m === 'fees')).toHaveLength(1);
        expect(x.calls.filter((m) => m === 'simulateBundle')).toHaveLength(1);
        expect(x.pace).toHaveBeenCalledTimes(lookup ? 10 : 6);
        expect(x.pace.mock.calls.every((call) => call.length === 2)).toBe(true);
      });

const coherentEndpoint =
  'https://solana-mainnet.g.alchemy.com/v2/synthetic-no-network';
for (const phase of ['discovery', 'batch'] as const)
  for (const shape of [
    'null-id',
    'wrong-id',
    'extra-fields',
    'partial-array',
  ] as const)
    it(`owned coherent malformed RPC429 ${phase}/${shape} stops all later provider reads`, async () => {
      vi.stubEnv('SOLANA_HOLDER_RPC_URL', coherentEndpoint);
      providerEnv.SOLANA_HOLDER_RPC_URL = coherentEndpoint;
      const x = await setup({ lookup: true, wallets: 4 }),
        methods: string[] = [];
      const fetcher: typeof fetch = async (url, init) => {
        const body = JSON.parse(init!.body as string);
        const method = Array.isArray(body)
          ? 'batch'
          : body.method === 'simulateBundle'
            ? 'discovery'
            : body.method;
        methods.push(method);
        if (method === phase) {
          const error = {
            jsonrpc: '2.0',
            id: shape === 'null-id' ? null : 'unrequested',
            error: { code: 429n },
            ...(shape === 'extra-fields' ? { unknown: true } : {}),
          };
          return new Response(
            x.f.wire(shape === 'partial-array' ? [error] : error),
          );
        }
        return x.dependencies.fetcher(url, init);
      };
      const result = await checkJitoBundleSequential(
        x.d.db,
        'owner',
        x.input,
        new AbortController().signal,
        { ...x.dependencies, fetcher },
      );
      expect(result).toMatchObject({
        status: 'refused',
        reason: 'rate-limited',
        simulationSlot: null,
        signingAllowed: false,
        economicOutputVerified: false,
      });
      expect(methods.at(-1)).toBe(phase);
      expect(methods.filter((m) => m === 'getGenesisHash')).toHaveLength(1);
      expect(methods.filter((m) => m === 'discovery')).toHaveLength(1);
      expect(methods.filter((m) => m === 'batch')).toHaveLength(
        phase === 'discovery' ? 0 : 1,
      );
    });
for (const side of ['Buy', 'Sell'] as const)
  for (const token2022 of [false, true])
    for (const lookup of [false, true])
      it(`owned coherent actual collector ${side}/2022=${token2022}/ALT=${lookup}`, async () => {
        vi.stubEnv('SOLANA_HOLDER_RPC_URL', coherentEndpoint);
        providerEnv.SOLANA_HOLDER_RPC_URL = coherentEndpoint;
        const x = await setup({ side, token2022, lookup, wallets: 4 });
        const before = x.d.sqlite.prepare('SELECT * FROM jito_bundles').all();
        const packetsBefore = x.d.sqlite
          .prepare('SELECT * FROM jito_bundle_packets')
          .all();
        const result = await checkJitoBundleSequential(
          x.d.db,
          'owner',
          x.input,
          new AbortController().signal,
          x.dependencies,
        );
        expect(result).toMatchObject({
          status: 'frames-observed',
          reason: 'frame-integrity-only',
          minimumSlot: 100,
          simulationSlot: 101,
          packetCount: 5,
          economicOutputVerified: false,
          signingAllowed: false,
          executionAllowed: false,
          providerQualified: false,
        });
        expect(result.fees).toHaveLength(5);
        expect(x.calls.filter((m) => m === 'discovery')).toHaveLength(1);
        expect(x.calls.filter((m) => m === 'coherentBatch')).toHaveLength(1);
        expect(x.calls).not.toContain('fees');
        expect(x.calls).not.toContain('simulateBundle');
        expect(x.calls).toHaveLength(lookup ? 12 : 4);
        expect(x.methodCounts.reduce((a, b) => a + b, 0)).toBe(lookup ? 17 : 9);
        expect(x.pace).toHaveBeenCalledTimes(lookup ? 17 : 9);
        expect(x.d.sqlite.prepare('SELECT * FROM jito_bundles').all()).toEqual(
          before,
        );
        expect(
          x.d.sqlite.prepare('SELECT * FROM jito_bundle_packets').all(),
        ).toEqual(packetsBefore);
        expect(Object.keys(result)).not.toContain('batch');
        expect(Object.keys(result)).not.toContain('discovery');
      });

for (const phase of ['discovery', 'batch'] as const)
  it(`coherent HTTP429 ${phase} stops without fallback`, async () => {
    vi.stubEnv('SOLANA_HOLDER_RPC_URL', coherentEndpoint);
    providerEnv.SOLANA_HOLDER_RPC_URL = coherentEndpoint;
    const x = await setup({ lookup: true, wallets: 4 });
    x.setCoherentStatus(phase, 429);
    const result = await checkJitoBundleSequential(
      x.d.db,
      'owner',
      x.input,
      new AbortController().signal,
      x.dependencies,
    );
    expect(result).toMatchObject({
      status: 'refused',
      reason: 'rate-limited',
      simulationSlot: null,
    });
    expect(x.calls.at(-1)).toBe(
      phase === 'discovery' ? 'discovery' : 'coherentBatch',
    );
    expect(x.calls.filter((m) => m === 'getGenesisHash')).toHaveLength(1);
    expect(x.calls).not.toContain('fees');
  });

for (const problem of [
  'fee-bank',
  'simulation-bank',
  'failed-simulation',
  'lookup',
  'genesis',
  'source',
] as const)
  it(`coherent path preserves ${problem} refusal`, async () => {
    vi.stubEnv('SOLANA_HOLDER_RPC_URL', coherentEndpoint);
    providerEnv.SOLANA_HOLDER_RPC_URL = coherentEndpoint;
    const x = await setup({ lookup: true, wallets: 4 });
    if (problem === 'fee-bank') {
      x.setSlots(101n, 102n);
      x.f.envelope.result.context.slot = 101n;
    }
    if (problem === 'simulation-bank') x.f.envelope.result.context.slot = 102n;
    if (problem === 'failed-simulation')
      x.setHook((method) => {
        if (method === 'coherentBatch')
          x.f.envelope.result.value.summary = 'failed';
      });
    if (problem === 'lookup') x.driftLookup();
    if (problem === 'genesis') x.driftGenesis();
    if (problem === 'source')
      x.setHook((method) => {
        if (method === 'coherentBatch')
          x.d.sqlite.prepare('UPDATE workspace_wallets SET revision=2').run();
      });
    const action = checkJitoBundleSequential(
      x.d.db,
      'owner',
      x.input,
      new AbortController().signal,
      x.dependencies,
    );
    if (problem === 'source')
      await expect(action).rejects.toThrow('Sequential check context');
    else
      expect(await action).toMatchObject({
        status: 'refused',
        simulationSlot: null,
        signingAllowed: false,
      });
    expect(x.calls.filter((m) => m === 'discovery')).toHaveLength(1);
    expect(x.calls.filter((m) => m === 'coherentBatch')).toHaveLength(1);
    expect(x.calls).not.toContain('fees');
    expect(x.calls).not.toContain('simulateBundle');
  });
it('refuses cross-owner, stale digest and invalid original source spans before network work', async () => {
  const x = await setup();
  for (const [owner, input] of [
    ['other', x.input],
    ['owner', { ...x.input, sha256: '0'.repeat(64) }],
  ] as const)
    await expect(
      checkJitoBundleSequential(
        x.d.db,
        owner,
        input,
        new AbortController().signal,
        x.dependencies,
      ),
    ).rejects.toThrow('Sequential check context');
  const invalid = await setup({ savedFeeSlot: 1 });
  await expect(
    checkJitoBundleSequential(
      invalid.d.db,
      'owner',
      invalid.input,
      new AbortController().signal,
      invalid.dependencies,
    ),
  ).rejects.toThrow('Sequential check context');
  expect(invalid.calls).toEqual([]);
  expect(x.calls).toEqual([]);
});
for (const phase of ['fees', 'simulation'] as const)
  it(`stops at ${phase} HTTP429 without further provider reads`, async () => {
    const x = await setup();
    x.setStatus(phase, 429);
    const result = await checkJitoBundleSequential(
      x.d.db,
      'owner',
      x.input,
      new AbortController().signal,
      x.dependencies,
    );
    expect(result).toMatchObject({
      status: 'refused',
      reason: 'rate-limited',
      simulationSlot: null,
    });
    expect(x.calls.at(-1)).toBe(phase === 'fees' ? 'fees' : 'simulateBundle');
    expect(x.calls.filter((m) => m === 'getGenesisHash')).toHaveLength(1);
  });
for (const drift of [
  'project-revision',
  'wallet-revision',
  'control-revision',
  'paused',
  'cancelled',
  'signed',
  'expired',
] as const)
  it(`rejects owned ${drift} drift after provider work`, async () => {
    const x = await setup();
    let changed = false;
    x.setHook(async (method) => {
      if (method !== 'fees' || changed) return;
      changed = true;
      if (drift === 'project-revision')
        x.d.sqlite
          .prepare('UPDATE imported_token_projects SET revision=2')
          .run();
      if (drift === 'wallet-revision')
        x.d.sqlite.prepare('UPDATE workspace_wallets SET revision=2').run();
      if (drift === 'control-revision')
        x.d.sqlite
          .prepare('UPDATE imported_trade_session_controls SET revision=3')
          .run();
      if (drift === 'paused')
        x.d.sqlite
          .prepare("UPDATE imported_trade_session_controls SET state='paused'")
          .run();
      if (drift === 'cancelled')
        x.d.sqlite.prepare("UPDATE jito_bundles SET state='cancelled'").run();
      if (drift === 'expired')
        vi.spyOn(Date, 'now').mockReturnValue(
          Date.parse(x.f.fixture.manifest.expiresAt) + 1,
        );
      if (drift === 'signed') {
        const r = x.f.fixture.manifest.swaps[0],
          tx = getTransactionDecoder().decode(
            Buffer.from(r.transaction, 'base64'),
          );
        const signature = nacl.sign.detached(
          Uint8Array.from(tx.messageBytes),
          nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).secretKey,
        ) as SignatureBytes;
        const signed = getBase64Decoder().decode(
          getTransactionEncoder().encode({
            ...tx,
            signatures: { [address(r.wallet)]: signature },
          }),
        );
        await registerJitoPacket(
          x.d.db,
          'owner',
          x.input.id,
          x.input.sha256,
          0,
          signed,
        );
      }
    });
    await expect(
      checkJitoBundleSequential(
        x.d.db,
        'owner',
        x.input,
        new AbortController().signal,
        x.dependencies,
      ),
    ).rejects.toThrow('Sequential check context');
  });
it('refuses ALT drift after a complete simulation instead of reporting frames observed', async () => {
  const x = await setup({ lookup: true });
  x.driftLookup();
  const result = await checkJitoBundleSequential(
    x.d.db,
    'owner',
    x.input,
    new AbortController().signal,
    x.dependencies,
  );
  expect(result).toMatchObject({
    status: 'refused',
    reason: 'simulation-refused',
    simulationSlot: null,
    altStateVerified: false,
  });
});
it('returns a fixed bank-unavailable refusal and never leaks raw provider data', async () => {
  const x = await setup();
  const fetcher: typeof fetch = async (url, init) => {
    if (typeof init?.body !== 'string')
      throw Error('Expected synthetic string body');
    const req = JSON.parse(init.body);
    if (req.method === 'simulateBundle')
      return new Response(
        x.f.wire({
          jsonrpc: '2.0',
          id: req.id,
          error: {
            code: -32602n,
            message: 'bank not found for the provided slot: 101',
            data: { secret: 'PRIVATE_PROVIDER_VALUE' },
          },
        }),
      );
    return x.dependencies.fetcher(url, init);
  };
  const result = await checkJitoBundleSequential(
    x.d.db,
    'owner',
    x.input,
    new AbortController().signal,
    { ...x.dependencies, fetcher },
  );
  expect(result).toMatchObject({
    status: 'refused',
    reason: 'bank-unavailable',
    simulationSlot: null,
  });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_PROVIDER_VALUE');
});
it('uses only the existing holder endpoint and never invokes the global network client in injected tests', async () => {
  const x = await setup(),
    network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(Error('network forbidden'));
  expect(
    (
      await checkJitoBundleSequential(
        x.d.db,
        'owner',
        x.input,
        new AbortController().signal,
        x.dependencies,
      )
    ).status,
  ).toBe('frames-observed');
  expect(network).not.toHaveBeenCalled();
  expect(typeof env).toBe('object');
});
it('admits the full original 32-slot boundary and refuses an ALT recheck at +33 without renewing the floor', async () => {
  const x = await setup({ lookup: true });
  x.setSlots(132n, 132n);
  expect(
    await checkJitoBundleSequential(
      x.d.db,
      'owner',
      x.input,
      new AbortController().signal,
      x.dependencies,
    ),
  ).toMatchObject({
    status: 'frames-observed',
    minimumSlot: 100,
    simulationSlot: 132,
  });
  const y = await setup({ lookup: true });
  y.setSlots(132n, 132n, 133n);
  expect(
    await checkJitoBundleSequential(
      y.d.db,
      'owner',
      y.input,
      new AbortController().signal,
      y.dependencies,
    ),
  ).toMatchObject({
    status: 'refused',
    minimumSlot: 100,
    simulationSlot: null,
  });
});
it('refuses a simulation bank preceding an admitted ALT observation', async () => {
  const x = await setup({ lookup: true });
  x.setSlots(102n, 101n);
  expect(
    await checkJitoBundleSequential(
      x.d.db,
      'owner',
      x.input,
      new AbortController().signal,
      x.dependencies,
    ),
  ).toMatchObject({
    status: 'refused',
    reason: 'simulation-refused',
    simulationSlot: null,
  });
});
it('covers maximum four-wallet ALT read and ordinary pacing budgets', async () => {
  const x = await setup({ lookup: true, wallets: 4 });
  expect(
    (
      await checkJitoBundleSequential(
        x.d.db,
        'owner',
        x.input,
        new AbortController().signal,
        x.dependencies,
      )
    ).status,
  ).toBe('frames-observed');
  expect(x.calls).toHaveLength(12);
  expect(x.pace).toHaveBeenCalledTimes(16);
});
it('does not evaluate client getters or accept client packet/floor fields', async () => {
  const x = await setup(),
    getter = vi.fn(() => x.input.id),
    request = { ...x.input };
  Object.defineProperty(request, 'id', { enumerable: true, get: getter });
  for (const input of [request, { ...x.input, packets: x.f.policy.packets }])
    await expect(
      checkJitoBundleSequential(
        x.d.db,
        'owner',
        input,
        new AbortController().signal,
        x.dependencies,
      ),
    ).rejects.toThrow('Sequential check context');
  expect(getter).not.toHaveBeenCalled();
  expect(x.calls).toEqual([]);
});
it('returns interruption promptly and cancels a late supporting response from a noncooperative fetcher', async () => {
  const x = await setup(),
    controller = new AbortController(),
    cancel = vi.fn();
  let complete!: (response: Response) => void;
  const fetcher: typeof fetch = async () => {
    queueMicrotask(() => controller.abort(Error('PRIVATE_ABORT_URL')));
    return new Promise<Response>((resolve) => {
      complete = resolve;
    });
  };
  const result = await checkJitoBundleSequential(
    x.d.db,
    'owner',
    x.input,
    controller.signal,
    { fetcher, pace: x.pace },
  );
  expect(result).toMatchObject({ status: 'refused', reason: 'interrupted' });
  const response = new Response(
    new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 }),
  );
  complete(response);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(cancel).toHaveBeenCalledOnce();
  expect(response.body?.locked).toBe(false);
  expect(JSON.stringify(result)).not.toContain('PRIVATE_ABORT_URL');
});
it('keeps native bundled preparation and intent immutability protections in the real test database', async () => {
  const x = await setup();
  expect(() =>
    x.d.sqlite
      .prepare("UPDATE imported_swap_preparations SET document='{}'")
      .run(),
  ).toThrow('immutable');
  expect(() =>
    x.d.sqlite
      .prepare("UPDATE imported_swap_signing_intents SET state='cancelled'")
      .run(),
  ).toThrow();
  expect(
    (
      await checkJitoBundleSequential(
        x.d.db,
        'owner',
        x.input,
        new AbortController().signal,
        x.dependencies,
      )
    ).status,
  ).toBe('frames-observed');
});
it('refuses a changed project document even with the same revision and units', async () => {
  const x = await setup();
  x.setHook((method) => {
    if (method === 'fees')
      x.d.sqlite
        .prepare(
          "UPDATE imported_token_projects SET document=json_set(document,'$.note','changed')",
        )
        .run();
  });
  await expect(
    checkJitoBundleSequential(
      x.d.db,
      'owner',
      x.input,
      new AbortController().signal,
      x.dependencies,
    ),
  ).rejects.toThrow('Sequential check context');
});
for (const phase of ['getGenesisHash', 'fees', 'simulateBundle'] as const)
  it(`stops on a JSON-RPC429 in ${phase} without a later genesis read`, async () => {
    const x = await setup(),
      calls: string[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      if (typeof init?.body !== 'string') throw Error('synthetic body');
      const request = JSON.parse(init.body),
        method = Array.isArray(request) ? 'fees' : request.method;
      calls.push(method);
      if (method === phase) {
        const row = (r: { id: string }) => ({
          jsonrpc: '2.0',
          id: r.id,
          error: { code: 429n, message: 'PRIVATE_RATE_LIMIT_PROVIDER_URL' },
        });
        return new Response(
          x.f.wire(Array.isArray(request) ? request.map(row) : row(request)),
        );
      }
      return x.dependencies.fetcher(url, init);
    };
    const result = await checkJitoBundleSequential(
      x.d.db,
      'owner',
      x.input,
      new AbortController().signal,
      { fetcher, pace: x.pace },
    );
    expect(result).toMatchObject({ status: 'refused', reason: 'rate-limited' });
    expect(calls.at(-1)).toBe(phase);
    expect(JSON.stringify(result)).not.toContain(
      'PRIVATE_RATE_LIMIT_PROVIDER_URL',
    );
  });
it('refuses quoted supporting slots and a changed final genesis without leaking source payloads', async () => {
  for (const variant of ['quoted-slot', 'final-genesis']) {
    const x = await setup({ lookup: true });
    let genesis = 0;
    const fetcher: typeof fetch = async (url, init) => {
      if (typeof init?.body !== 'string') throw Error('synthetic body');
      const request = JSON.parse(init.body);
      if (
        request.method === 'getGenesisHash' &&
        ++genesis === 2 &&
        variant === 'final-genesis'
      )
        return new Response(
          x.f.wire({ jsonrpc: '2.0', id: request.id, result: 'WRONG_NETWORK' }),
        );
      const response = await x.dependencies.fetcher(url, init);
      if (
        request.method === 'getMultipleAccounts' &&
        variant === 'quoted-slot'
      ) {
        const value = JSON.parse(await response.text());
        value.result.context.slot = '101';
        return new Response(JSON.stringify(value));
      }
      return response;
    };
    const result = await checkJitoBundleSequential(
      x.d.db,
      'owner',
      x.input,
      new AbortController().signal,
      { fetcher, pace: x.pace },
    );
    expect(result.status).toBe('refused');
    expect(result.simulationSlot).toBeNull();
  }
});
