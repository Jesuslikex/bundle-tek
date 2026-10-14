import { expect, it, vi, afterEach } from 'vitest';
import {
  address,
  getBase64Decoder,
  getCompiledTransactionMessageEncoder,
} from '@solana/kit';
import { counterPreparationFixture as fixture } from '../test/counter-preparation-fixture';
import { routeWallet } from '../test/jupiter-route-fixture';
import { prepareCounterBuyProposal } from './counter-buy-preparation';
import { readCounterProviderResponse } from './counter-provider-response';
import bs58 from 'bs58';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';

const prepare = (
  f: ReturnType<typeof fixture>,
  fetcher: typeof fetch,
  signal = new AbortController().signal,
) =>
  prepareCounterBuyProposal(
    f.plan,
    f.identity,
    '1005',
    routeWallet,
    'test-key',
    signal,
    fetcher,
  );
afterEach(() => vi.restoreAllMocks());
it('builds an inspected actual unsigned ExactOut packet from a fresh target and explicit budget', async () => {
  const f = fixture(),
    before = structuredClone(f.plan),
    calls: { url: string; init?: RequestInit }[] = [];
  const result = await prepare(f, async (url, init) => {
    calls.push({
      url:
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      init,
    });
    return Response.json(calls.length === 1 ? f.quote : f.swap);
  });
  expect(calls).toHaveLength(2);
  expect(new URL(calls[0].url).pathname).toBe('/swap/v1/quote');
  expect(new URL(calls[0].url).searchParams.get('instructionVersion')).toBe(
    'V1',
  );
  expect(new URL(calls[0].url).searchParams.get('asLegacyTransaction')).toBe(
    'false',
  );
  expect(calls[1].url).toBe('https://api.jup.ag/swap/v1/swap');
  expect(calls[1].init).toMatchObject({
    method: 'POST',
    redirect: 'manual',
    cache: 'no-store',
  });
  const bodyText = calls[1].init?.body;
  if (typeof bodyText !== 'string')
    throw new Error('JSON request body expected.');
  const body = JSON.parse(bodyText);
  expect(body).toMatchObject({
    userPublicKey: routeWallet,
    wrapAndUnwrapSol: true,
    useSharedAccounts: true,
    asLegacyTransaction: false,
    dynamicSlippage: false,
    prioritizationFeeLamports: 0,
    quoteResponse: {
      swapMode: 'ExactOut',
      outAmount: f.response.outAmount,
      inAmount: '1000',
      otherAmountThreshold: '1005',
    },
  });
  expect(bodyText).not.toContain('PRIVATE');
  for (const key of [
    'payer',
    'destinationTokenAccount',
    'nativeDestinationAccount',
    'feeAccount',
    'trackingAccount',
  ])
    expect(body).not.toHaveProperty(key);
  expect(result).toMatchObject({
    format: 'counter-buy-preparation-v1',
    executionAllowed: false,
    instructionsVerified: false,
    review: { assessment: { status: 'Matched fields' } },
    preparation: {
      transaction: f.swap.swapTransaction,
      lastValidBlockHeight: '123456',
      estimatedFeesLamports: null,
      lookupAccounts: null,
    },
  });
  expect(result.preparation.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(f.plan).toEqual(before);
});
it.each([
  { swapTransaction: 'PRIVATE-MALFORMED' },
  { lastValidBlockHeight: 0 },
  { lastValidBlockHeight: 1.1 },
  { prioritizationFeeLamports: 1 },
  { prioritizationFeeLamports: undefined },
  { dynamicSlippageReport: { slippageBps: 99 } },
  { simulationError: { private: 'PRIVATE-DETAIL' } },
  { error: 'PRIVATE-DETAIL' },
])(
  'rejects changed provider protection or malformed packet %j',
  async (patch) => {
    const f = fixture();
    let n = 0;
    await expect(
      prepare(f, async () =>
        Response.json(++n === 1 ? f.quote : { ...f.swap, ...patch }),
      ),
    ).rejects.toThrow();
  },
);
it('rejects pre-signed packets and wrong signers', async () => {
  for (const changed of ['signed', 'wallet']) {
    const f = fixture(),
      bytes = Uint8Array.from(atob(f.swap.swapTransaction), (c) =>
        c.charCodeAt(0),
      );
    if (changed === 'signed') bytes[1] = 1;
    else bytes[70] ^= 1;
    f.swap.swapTransaction = btoa(String.fromCharCode(...bytes));
    let n = 0;
    await expect(
      prepare(f, async () => Response.json(++n === 1 ? f.quote : f.swap)),
    ).rejects.toThrow('unsupported unsigned packet');
  }
});
it('rejects instructions that substitute another token target or a platform fee', async () => {
  for (const options of [{ fee: 1 }, { amount: 1001n }]) {
    const f = fixture(options);
    // Amount fields are deliberately rewritten by the fixture. Mutate the wire
    // trailer afterward so the provider response cannot rely on quote metadata.
    if (options.amount) {
      const data = Uint8Array.from(f.message.instructions[0].data!);
      new DataView(data.buffer).setBigUint64(
        data.length - 19,
        BigInt(f.response.outAmount!) + 1n,
        true,
      );
      f.message.instructions[0].data = data;
      f.swap.swapTransaction = getBase64Decoder().decode(
        Uint8Array.from([
          1,
          ...new Uint8Array(64),
          ...getCompiledTransactionMessageEncoder().encode(f.message),
        ]),
      );
    }
    let n = 0;
    await expect(
      prepare(f, async () => Response.json(++n === 1 ? f.quote : f.swap)),
    ).rejects.toThrow('could not be matched');
  }
});
it.each([302, 401, 429, 503])(
  'sanitizes preparation HTTP %s without returning upstream HTML',
  async (status) => {
    const f = fixture();
    let n = 0;
    await expect(
      prepare(f, async () =>
        ++n === 1
          ? Response.json(f.quote)
          : new Response('PRIVATE-HTML', { status }),
      ),
    ).rejects.toMatchObject({
      message: expect.not.stringContaining('PRIVATE'),
    });
  },
);
it('bounds malformed JSON, invalid UTF-8 and oversized preparation bodies', async () => {
  for (const body of [
    'PRIVATE-HTML',
    'x'.repeat(8193),
    new Uint8Array([255]),
  ]) {
    const f = fixture();
    let n = 0;
    await expect(
      prepare(f, async () =>
        ++n === 1 ? Response.json(f.quote) : new Response(body),
      ),
    ).rejects.toMatchObject({
      message: expect.not.stringContaining('PRIVATE'),
    });
  }
});
it('never requests a packet when the fresh quote exceeds the reviewed budget or metadata is missing', async () => {
  for (const patch of [
    { otherAmountThreshold: '1006' },
    { priceImpactPct: undefined },
    { routePlan: [{ ...fixture().quote.routePlan[0], percent: NaN }] },
  ]) {
    const f = fixture(),
      fetcher = vi.fn(async () => Response.json({ ...f.quote, ...patch }));
    await expect(prepare(f, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});
it('rejects cancellation before and after the packet response', async () => {
  const f = fixture(),
    controller = new AbortController(),
    fetcher = vi.fn();
  controller.abort();
  await expect(prepare(f, fetcher, controller.signal)).rejects.toThrow(
    'cancelled',
  );
  expect(fetcher).not.toHaveBeenCalled();
  const after = new AbortController();
  let n = 0;
  await expect(
    prepare(
      f,
      async () => {
        if (++n === 1) return Response.json(f.quote);
        after.abort();
        return Response.json(f.swap);
      },
      after.signal,
    ),
  ).rejects.toThrow('cancelled');
});
it('cancels a stalled response body and sanitizes body-stream failures', async () => {
  const controller = new AbortController(),
    cancelled = vi.fn();
  const pending = readCounterProviderResponse(
    new Response(new ReadableStream({ cancel: cancelled })),
    controller.signal,
    'Counter preparation',
    8192,
  );
  controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
  expect(cancelled).toHaveBeenCalled();
  await expect(
    readCounterProviderResponse(
      new Response(
        new ReadableStream({
          start(c) {
            c.error(Error('PRIVATE-BODY'));
          },
        }),
      ),
      new AbortController().signal,
      'Counter preparation',
      8192,
    ),
  ).rejects.toMatchObject({ message: expect.not.stringContaining('PRIVATE') });
});
it('rejects a quote that expired while the provider built the packet', async () => {
  const f = fixture(),
    start = Date.now();
  let n = 0;
  await expect(
    prepare(f, async () => {
      if (++n === 1) return Response.json(f.quote);
      vi.spyOn(Date, 'now').mockReturnValue(start + 31000);
      return Response.json(f.swap);
    }),
  ).rejects.toThrow('expired');
});
it('preserves the reviewed plan snapshot when the caller mutates it during I/O', async () => {
  const f = fixture();
  let n = 0;
  const result = await prepare(f, async () => {
    if (++n === 1) {
      f.plan.state = 'ended';
      f.plan.revision = 99;
      return Response.json(f.quote);
    }
    return Response.json(f.swap);
  });
  expect(result.review.planRevision).toBe(2);
});

it('resolves an actual lookup-backed output mint and retains table hashes for later simulation', async () => {
  const f = fixture();
  if (f.message.version !== 0) throw new Error('Invalid fixture.');
  f.message.staticAccounts.splice(4, 1);
  f.message.header.numReadonlyNonSignerAccounts--;
  f.message.addressTableLookups = [
    {
      lookupTableAddress: address(routeWallet),
      writableIndexes: [],
      readonlyIndexes: [0],
    },
  ];
  const instruction = f.message.instructions[0];
  instruction.programAddressIndex = 5;
  instruction.accountIndices = Array.from(instruction.accountIndices!, (i) =>
    i === 4 ? 6 : i > 4 ? i - 1 : i,
  );
  f.swap.swapTransaction = getBase64Decoder().decode(
    Uint8Array.from([
      1,
      ...new Uint8Array(64),
      ...getCompiledTransactionMessageEncoder().encode(f.message),
    ]),
  );
  const bytes = new Uint8Array(88),
    view = new DataView(bytes.buffer);
  view.setUint32(0, 1, true);
  view.setBigUint64(4, (1n << 64n) - 1n, true);
  view.setBigUint64(12, 90n, true);
  bytes.set(bs58.decode(f.quote.outputMint), 56);
  const account = {
    owner: 'AddressLookupTab1e1111111111111111111111111',
    executable: false,
    data: [btoa(String.fromCharCode(...bytes)), 'base64'],
  };
  const rpc = vi.fn(async (method: string) =>
    method === 'getGenesisHash'
      ? SOLANA_MAINNET_GENESIS
      : { context: { slot: '100' }, value: [account] },
  );
  let n = 0;
  const result = await prepareCounterBuyProposal(
    f.plan,
    f.identity,
    '1005',
    routeWallet,
    'test-key',
    new AbortController().signal,
    async () => Response.json(++n === 1 ? f.quote : f.swap),
    rpc,
  );
  expect(result.preparation.lookupAccounts).toMatchObject({
    observedSlot: 100,
    readonly: [f.quote.outputMint],
    tables: [{ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }],
  });
  expect(result.review.assessment.status).toBe('Matched fields');
  expect(rpc.mock.calls.map((c) => c[0])).toEqual([
    'getGenesisHash',
    'getMultipleAccounts',
  ]);
  for (const provider of [
    undefined,
    async () => 'wrong-network',
    async (method: string) =>
      method === 'getGenesisHash'
        ? SOLANA_MAINNET_GENESIS
        : { context: { slot: '99' }, value: [account] },
  ]) {
    let calls = 0;
    await expect(
      prepareCounterBuyProposal(
        f.plan,
        f.identity,
        '1005',
        routeWallet,
        'test-key',
        new AbortController().signal,
        async () => Response.json(++calls === 1 ? f.quote : f.swap),
        provider,
      ),
    ).rejects.toThrow(/lookup-account/);
  }
});
