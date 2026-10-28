import * as solanaRpc from './solana-rpc';
import { expect, it, vi } from 'vitest';
import { solanaTransferMessage } from './solana-funding';
import { prepareSolanaSwap, WRAPPED_SOL } from './warmup-swap-quote';
import {
  simulateImportedSwap,
  SwapBlockhashExpiredError,
} from './imported-swap-simulation';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import bs58 from 'bs58';
import { getCompiledTransactionMessageEncoder } from '@solana/kit';
import { routeMessage } from '../test/jupiter-route-fixture';
import { tokenAccountFixture } from '../test/swap-token-account-fixture';
import { requireWarmupSigningReview } from './warmup-signing';
const wallet = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
const other = '8phnoC6V8nwYnNUwobNBoWzWAmyP1nj9GyYZaMbU8z4';
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
async function order(withLookup = false, withRoute = false) {
  const bytes = withRoute
    ? Uint8Array.from([
        1,
        ...new Uint8Array(64),
        ...getCompiledTransactionMessageEncoder().encode(routeMessage()),
      ])
    : Uint8Array.from([
        1,
        ...new Uint8Array(64),
        128,
        ...solanaTransferMessage(
          wallet,
          other,
          '11111111111111111111111111111111',
          1n,
        ),
        ...(withLookup ? [1, ...bs58.decode(mint), 1, 1, 1, 0] : [0]),
      ]);
  return prepareSolanaSwap(
    { tokenMint: mint, side: 'Buy', amount: '0.001', decimals: 6, wallet },
    'key',
    AbortSignal.timeout(1000),
    async () =>
      Response.json({
        transaction: btoa(String.fromCharCode(...bytes)),
        transactionVersion: 0,
        taker: wallet,
        gasless: false,
        signatureFeeLamports: 5000,
        signatureFeePayer: wallet,
        prioritizationFeeLamports: 0,
        prioritizationFeePayer: null,
        rentFeeLamports: 0,
        rentFeePayer: null,
        lastValidBlockHeight: '120',
        inputMint: WRAPPED_SOL,
        outputMint: mint,
        inAmount: '1000000',
        outAmount: '1000',
        otherAmountThreshold: '995',
        swapMode: 'ExactIn',
        slippageBps: 50,
        router: 'metis',
      }),
  );
}
const fixture = (patch: Record<string, unknown> = {}) => {
  const results: Record<string, unknown> = {
    getGenesisHash: SOLANA_MAINNET_GENESIS,
    getBlockHeight: 100,
    getFeeForMessage: { context: { slot: 100 }, value: 5000 },
    getMultipleAccounts: { context: { slot: '101' }, value: [null, null] },
    simulateTransaction: {
      context: { slot: 101 },
      value: {
        err: null,
        unitsConsumed: 1000,
        preBalances: ['18446744073709551615', '0', '1'],
        postBalances: ['18446744073709546614', '1', '1'],
      },
    },
    ...patch,
  };
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const bodyText = init?.body;
    if (typeof bodyText !== 'string')
      throw new Error('Expected JSON request body.');
    const body = JSON.parse(bodyText) as { method: string };
    return Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: results[body.method],
    });
  });
};
it('withholds approval when the original blockhash is unavailable without replacing or broadcasting the packet', async () => {
  const prepared = await order();
  const rpc = fixture({
    simulateTransaction: {
      context: { slot: 101 },
      value: { err: 'BlockhashNotFound', unitsConsumed: 0 },
    },
  });
  const result = await simulateImportedSwap(
    prepared,
    AbortSignal.timeout(1000),
    rpc as typeof fetch,
  );
  expect(result).toMatchObject({
    succeeded: false,
    tokensComplete: false,
    failureReason: 'BlockhashNotFound',
    nativeChangeRaw: null,
  });
  await expect(requireWarmupSigningReview(prepared, result)).rejects.toThrow(
    'blockhash is unavailable',
  );
  const calls = rpc.mock.calls.map((call) =>
    JSON.parse(call[1]!.body as string),
  );
  expect(
    calls.find((call) => call.method === 'simulateTransaction').params[1]
      .replaceRecentBlockhash,
  ).toBe(false);
  expect(
    calls.some(
      (call) =>
        call.method === 'sendTransaction' ||
        call.method === 'getLatestBlockhash',
    ),
  ).toBe(false);
});
it('observes exact route token account ownership after simulation without granting execution clearance', async () => {
  const prepared = await order(false, true);
  const rpc = fixture({
    simulateTransaction: {
      context: { slot: 101 },
      value: {
        err: null,
        unitsConsumed: 1000,
        preBalances: Array(7).fill('10000000'),
        postBalances: Array(7).fill('10000000'),
      },
    },
    getMultipleAccounts: {
      context: { slot: 102 },
      value: [tokenAccountFixture(), tokenAccountFixture(mint)],
    },
  });
  const result = await simulateImportedSwap(
    prepared,
    AbortSignal.timeout(1000),
    rpc as typeof fetch,
  );
  expect(result.accountBindings).toMatchObject({
    status: 'Matched bindings',
    slot: 102,
  });
  expect(result.routeAssessment.status).toBe('Matched fields');
  expect(result.instructionsVerified).toBe(false);
  expect(result.executionAllowed).toBe(false);
  const calls = rpc.mock.calls.map((call) =>
    JSON.parse(call[1]!.body as string),
  );
  expect(
    calls.find((call) => call.method === 'getMultipleAccounts').params[1]
      .minContextSlot,
  ).toBe(101);
  expect(
    calls.findIndex((call) => call.method === 'getMultipleAccounts'),
  ).toBeGreaterThan(
    calls.findIndex((call) => call.method === 'simulateTransaction'),
  );
});
it('simulates the exact unsigned bytes and reports independent fee and exact SOL change without swap clearance', async () => {
  const prepared = await order(),
    rpc = fixture();
  const result = await simulateImportedSwap(
    prepared,
    AbortSignal.timeout(1000),
    rpc as typeof fetch,
  );
  expect(result).toMatchObject({
    executionAllowed: false,
    instructionsVerified: false,
    succeeded: true,
    sha256: prepared.preparation.sha256,
    networkFeeLamports: '5000',
    nativeChangeRaw: '-5001',
    feeSlot: 100,
    simulationSlot: 101,
    routeAssessment: {
      status: 'Unavailable',
      executionAllowed: false,
      instructionsVerified: false,
    },
  });
  const requests = rpc.mock.calls.map((call) => {
    const bodyText = call[1]?.body;
    if (typeof bodyText !== 'string')
      throw new Error('Expected JSON request body.');
    return JSON.parse(bodyText) as {
      method: string;
      params: unknown[];
    };
  });
  const simulation = requests.find((r) => r.method === 'simulateTransaction')!;
  expect(simulation.params).toEqual([
    prepared.preparation.transaction,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      sigVerify: false,
      replaceRecentBlockhash: false,
      minContextSlot: 100,
      innerInstructions: false,
      logs: true,
    },
  ]);
  expect(requests.some((r) => r.method === 'sendTransaction')).toBe(false);
  expect(result).not.toHaveProperty('logs');
});
it('binds lookup-backed instruction review to table observations before and after simulation', async () => {
  const prepared = await order(true);
  for (const mode of ['valid', 'changed', 'conflict'] as const) {
    const table = new Uint8Array(120),
      view = new DataView(table.buffer);
    view.setUint32(0, 1, true);
    view.setBigUint64(4, (1n << 64n) - 1n, true);
    view.setBigUint64(12, 90n, true);
    table.set(bs58.decode('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), 56);
    table.set(bs58.decode(other), 88);
    let reads = 0;
    const base = fixture({
      simulateTransaction: {
        context: { slot: 102 },
        value: {
          err: null,
          unitsConsumed: 1000,
          preBalances: ['10000000', '0', '1', '2', '3'],
          postBalances: ['9994999', '1', '1', '2', '3'],
          ...(mode === 'conflict'
            ? {
                loadedAddresses: {
                  writable: [wallet],
                  readonly: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
                },
              }
            : {}),
        },
      },
    });
    const provider = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('Expected JSON body');
      const body = JSON.parse(init.body);
      if (body.method !== 'getMultipleAccounts') return base(input, init);
      // The wallet token-account bindings read two addresses; the lookup table
      // read is a single address.
      if (Array.isArray(body.params?.[0]) && body.params[0].length === 2)
        return Response.json({
          jsonrpc: '2.0',
          id: 1,
          result: { context: { slot: 103 }, value: [null, null] },
        });
      reads++;
      if (reads === 2 && mode === 'changed') table[88] ^= 1;
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: {
          context: { slot: reads === 1 ? 101 : 103 },
          value: [
            {
              owner: 'AddressLookupTab1e1111111111111111111111111',
              executable: false,
              data: [btoa(String.fromCharCode(...table)), 'base64'],
            },
          ],
        },
      });
    });
    const pending = simulateImportedSwap(
      prepared,
      AbortSignal.timeout(2000),
      provider as typeof fetch,
    );
    if (mode === 'valid') {
      const result = await pending;
      expect(result).toMatchObject({
        instructionsVerified: false,
        executionAllowed: false,
        lookupObservation: {
          slot: 101,
          recheckSlot: 103,
          tables: [{ address: mint, lastExtendedSlot: '90' }],
        },
        instructionReview: { unresolvedAccountCount: 0 },
      });
      const simulation = provider.mock.calls
        .map((call) => {
          if (typeof call[1]?.body !== 'string')
            throw new Error('Expected JSON body');
          return JSON.parse(call[1].body);
        })
        .find((r) => r.method === 'simulateTransaction');
      expect(simulation.params[1].minContextSlot).toBe(101);
    } else
      await expect(pending).rejects.toThrow(
        mode === 'changed' ? 'changed' : 'mismatch',
      );
    expect(reads).toBe(2);
  }
});
it('classifies expired block heights without replacing, simulating or sending the packet', async () => {
  const prepared = await order();
  const rpc = fixture({ getBlockHeight: 121 });
  await expect(
    simulateImportedSwap(
      prepared,
      AbortSignal.timeout(1000),
      rpc as typeof fetch,
    ),
  ).rejects.toBeInstanceOf(SwapBlockhashExpiredError);
  const methods = rpc.mock.calls.map(
    (call) =>
      JSON.parse(typeof call[1]?.body === 'string' ? call[1].body : '{}')
        .method,
  );
  expect(methods).not.toContain('simulateTransaction');
  expect(methods).not.toContain('sendTransaction');
  expect(prepared.preparation.transaction).toBeTruthy();
});
it('rejects wrong genesis, expired height, null fee, replaced hash and incoherent simulation contexts', async () => {
  const prepared = await order();
  for (const patch of [
    { getGenesisHash: 'devnet' },
    { getBlockHeight: 121 },
    { getFeeForMessage: { context: { slot: 100 }, value: null } },
    {
      simulateTransaction: {
        context: { slot: 99 },
        value: { err: null, unitsConsumed: 1000 },
      },
    },
    {
      simulateTransaction: {
        context: { slot: 133 },
        value: { err: null, unitsConsumed: 1000 },
      },
    },
    {
      simulateTransaction: {
        context: { slot: 101 },
        value: {
          err: null,
          unitsConsumed: 1000,
          replacementBlockhash: { blockhash: 'changed' },
        },
      },
    },
    {
      simulateTransaction: {
        context: { slot: 101 },
        value: {
          err: null,
          unitsConsumed: 1000,
          preBalances: [],
          postBalances: [],
        },
      },
    },
  ])
    await expect(
      simulateImportedSwap(
        prepared,
        AbortSignal.timeout(1000),
        fixture(patch) as typeof fetch,
      ),
    ).rejects.toThrow();
  const rpc = fixture();
  await expect(
    simulateImportedSwap(
      {
        ...prepared,
        preparation: { ...prepared.preparation, sha256: 'changed' },
      },
      AbortSignal.timeout(1000),
      rpc as typeof fetch,
    ),
  ).rejects.toThrow('fingerprint');
  expect(rpc).not.toHaveBeenCalled();
});
it('reports failed execution simulation without logs or successful balance claims', async () => {
  const prepared = await order();
  const result = await simulateImportedSwap(
    prepared,
    AbortSignal.timeout(1000),
    fixture({
      simulateTransaction: {
        context: { slot: 101 },
        value: {
          err: { InstructionError: [0, { Custom: 1 }] },
          unitsConsumed: 12,
          logs: ['private provider details'],
        },
      },
    }) as typeof fetch,
  );
  expect(result.succeeded).toBe(false);
  expect(result.nativeChangeRaw).toBeNull();
  expect(result.tokensComplete).toBe(false);
  expect(result.minimumOutputCovered).toBeNull();
  expect(JSON.stringify(result)).not.toContain('private');
});
it('checks wallet-attributed token output in the actual lossless RPC simulation response', async () => {
  const prepared = await order();
  const result = await simulateImportedSwap(
    prepared,
    AbortSignal.timeout(1000),
    fixture({
      simulateTransaction: {
        context: { slot: 101 },
        value: {
          err: null,
          unitsConsumed: 1000,
          preBalances: ['10000000', '0', '1'],
          postBalances: ['8995000', '0', '1'],
          preTokenBalances: [],
          postTokenBalances: [
            {
              accountIndex: 1,
              mint,
              owner: wallet,
              programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
              uiTokenAmount: { amount: '994', decimals: 6 },
            },
          ],
          loadedAddresses: { writable: [], readonly: [] },
        },
      },
    }) as typeof fetch,
  );
  expect(result).toMatchObject({
    tokensComplete: true,
    inputAmountMatches: null,
    minimumOutputCovered: false,
    executionAllowed: false,
    instructionsVerified: false,
  });
  expect(result.tokenChanges[0]).toMatchObject({
    mint,
    changeRaw: '994',
    accounts: [other],
  });
});
it('does not log a credential-bearing endpoint when block height has expired', async () => {
  const prepared = await order();
  const endpoint = 'https://rpc.synthetic.invalid/fixture-private-key';
  const provider = vi
    .spyOn(solanaRpc, 'getSolanaIndexerRpcEndpoint')
    .mockReturnValue(endpoint);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const rpc = fixture({ getBlockHeight: 121 });
  try {
    await expect(
      simulateImportedSwap(
        prepared,
        AbortSignal.timeout(1000),
        rpc as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(SwapBlockhashExpiredError);
    expect(rpc.mock.calls.every(([url]) => url === endpoint)).toBe(true);
    const output = JSON.stringify([
      ...error.mock.calls,
      ...warn.mock.calls,
      ...log.mock.calls,
    ]);
    expect(output).not.toContain(endpoint);
    expect(output).not.toContain('fixture-private-key');
    expect(error).toHaveBeenCalledWith('blockhash check', {
      blockHeight: '121',
      lastValid: '120',
    });
  } finally {
    provider.mockRestore();
    error.mockRestore();
    warn.mockRestore();
    log.mockRestore();
  }
});
it('sanitizes simulation failure logs without changing the failed outcome', async () => {
  const prepared = await order();
  const endpoint =
    'https://syntheticsecretalpha.rpc.invalid/private-credential';
  const provider = vi
    .spyOn(solanaRpc, 'getSolanaIndexerRpcEndpoint')
    .mockReturnValue(endpoint);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const rpc = fixture({
      simulateTransaction: {
        context: { slot: 101 },
        value: {
          err: 'SyntheticSecretAlpha',
          unitsConsumed: 0,
          logs: [endpoint, 'private-credential'],
        },
      },
    });
    const result = await simulateImportedSwap(
      prepared,
      AbortSignal.timeout(1000),
      rpc as typeof fetch,
    );
    expect(result.succeeded).toBe(false);
    expect(rpc.mock.calls.every(([url]) => url === endpoint)).toBe(true);
    const output = JSON.stringify([
      ...error.mock.calls,
      ...warn.mock.calls,
      ...log.mock.calls,
    ]);
    expect(output).not.toContain('syntheticsecretalpha');
    expect(output).not.toContain('SyntheticSecretAlpha');
    expect(output).not.toContain('private-credential');
    expect(error).toHaveBeenCalledWith('Unsigned swap simulation failed', {
      kind: 'Transaction failure',
      instructionIndex: null,
      customCode: null,
    });
    error.mockClear();
    const instructionRpc = fixture({
      simulateTransaction: {
        context: { slot: 101 },
        value: {
          err: { InstructionError: [2, { Custom: 7 }] },
          unitsConsumed: 0,
          logs: [endpoint],
        },
      },
    });
    expect(
      (
        await simulateImportedSwap(
          prepared,
          AbortSignal.timeout(1000),
          instructionRpc as typeof fetch,
        )
      ).succeeded,
    ).toBe(false);
    expect(error).toHaveBeenCalledWith('Unsigned swap simulation failed', {
      kind: 'Instruction failure',
      instructionIndex: 2,
      customCode: 7,
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain(
      'syntheticsecretalpha',
    );
  } finally {
    provider.mockRestore();
    error.mockRestore();
    warn.mockRestore();
    log.mockRestore();
  }
});
it('omits untrusted out-of-range instruction and custom codes', async () => {
  const prepared = await order();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const [index, code] of [
      [-1, -1],
      [256, 4294967296],
      ['01', '7secret'],
    ] as const) {
      const rpc = fixture({
        simulateTransaction: {
          context: { slot: 101 },
          value: {
            err: { InstructionError: [index, { Custom: code }] },
            unitsConsumed: 0,
          },
        },
      });
      expect(
        (
          await simulateImportedSwap(
            prepared,
            AbortSignal.timeout(1000),
            rpc as typeof fetch,
          )
        ).succeeded,
      ).toBe(false);
      expect(error).toHaveBeenLastCalledWith(
        'Unsigned swap simulation failed',
        {
          kind: 'Instruction failure',
          instructionIndex: null,
          customCode: null,
        },
      );
    }
  } finally {
    error.mockRestore();
  }
});
