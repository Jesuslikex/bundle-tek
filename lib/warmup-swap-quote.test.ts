import { it, expect, vi } from 'vitest';
import {
  quoteWarmupBuy,
  prepareSolanaSwap,
  WarmupQuoteError,
  quoteSolanaBuy,
  quoteSolanaSell,
  quoteSolanaPair,
  WRAPPED_SOL,
} from './warmup-swap-quote';
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
it('cancels a rejected provider body without reading or exposing it', async () => {
  const cancel = vi.fn(),
    fetcher = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode('PRIVATE_PROVIDER_ERROR'));
            },
            cancel,
          }),
          { status: 429 },
        ),
    );
  await expect(
    quoteSolanaBuy(
      { outputMint: mint, amount: '0.001' },
      'synthetic-key',
      new AbortController().signal,
      fetcher,
    ),
  ).rejects.toMatchObject({ code: 'QUOTE_UNAVAILABLE' });
  expect(cancel).toHaveBeenCalledTimes(1);
});
it('cancels a stalled quote response body when the request is aborted', async () => {
  const c = new AbortController(),
    cancel = vi.fn();
  let opened!: () => void;
  const started = new Promise<void>((r) => {
    opened = r;
  });
  const fetcher = vi.fn(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
            opened();
          },
          cancel,
        }),
        { status: 200 },
      ),
  );
  const pending = quoteSolanaBuy(
    { outputMint: mint, amount: '0.001' },
    'synthetic-key',
    c.signal,
    fetcher,
  );
  await started;
  c.abort(new DOMException('Synthetic cancellation', 'AbortError'));
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancel).toHaveBeenCalledTimes(1);
});
const doc = () => ({
  name: 'QA',
  chain: 'Solana',
  addresses: ['11111111111111111111111111111111'],
  walletRevisions: [
    { address: '11111111111111111111111111111111', revision: 1 },
  ],
  tokens: [mint],
  amount: '0.001',
  feeReserve: '0.01',
  cycles: 3,
  intervalMinutes: 60,
  startAt: new Date(Date.now() + 3600000).toISOString(),
  totalBudget: '0.013',
});
const result = {
  inputMint: WRAPPED_SOL,
  outputMint: mint,
  inAmount: '1000000',
  outAmount: '1000',
  otherAmountThreshold: '995',
  swapMode: 'ExactIn',
  slippageBps: 50,
  router: 'metis',
  transaction: 'untrustedTransaction',
  requestId: 'untrustedRequest',
};
it.each(['metis', 'jupiterz', 'dflow', 'okx'] as const)(
  'warmup quotes request executable routing and refuse ignored exclusions: %s',
  async (router) => {
    const fetcher = vi.fn(async (_url: unknown) =>
      Response.json({ ...result, router }),
    );
    const pending = quoteWarmupBuy(
      doc(),
      'qa-key',
      AbortSignal.timeout(1000),
      fetcher,
    );
    if (router === 'metis')
      await expect(pending).resolves.toMatchObject({
        side: 'Buy',
        cycle: 1,
        router: 'metis',
        executionAllowed: false,
      });
    else
      await expect(pending).rejects.toMatchObject({
        code: 'UNSUPPORTED_ROUTER',
      });
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.searchParams.get('excludeRouters')).toBe('jupiterz,dflow,okx');
    expect(url.searchParams.get('slippageBps')).toBe('50');
    expect(url.searchParams.has('taker')).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
it.each(['metis', 'jupiterz', 'dflow', 'okx'] as const)(
  'aligns unsigned pair reference quotes with wallet-bound routing and rejects ignored exclusions: %s',
  async (router) => {
    const fetcher = vi.fn(async (_url: unknown) =>
      Response.json({ ...result, router }),
    );
    const pending = quoteSolanaPair(
      {
        baseMint: mint,
        quoteMint: WRAPPED_SOL,
        side: 'Buy',
        amountRaw: '1000000',
      },
      'qa-key',
      new AbortController().signal,
      fetcher,
    );
    if (router === 'metis')
      await expect(pending).resolves.toMatchObject({
        router: 'metis',
        slippageBps: 50,
      });
    else
      await expect(pending).rejects.toMatchObject({
        code: 'UNSUPPORTED_ROUTER',
      });
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.searchParams.get('excludeRouters')).toBe('jupiterz,dflow,okx');
    expect(url.searchParams.get('slippageBps')).toBe('50');
    expect(url.searchParams.has('taker')).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
it('preserves broader quote-only routing for the existing non-pair swap flow', async () => {
  const fetcher = vi.fn(async (_url: unknown) =>
    Response.json({ ...result, router: 'okx' }),
  );
  await expect(
    quoteSolanaBuy(
      { outputMint: mint, amount: '0.001' },
      'qa-key',
      new AbortController().signal,
      fetcher,
    ),
  ).resolves.toMatchObject({ router: 'okx' });
  expect(
    new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.has(
      'excludeRouters',
    ),
  ).toBe(false);
});
it.each([
  ['QUOTE_EXPIRED', { expireAt: '2000-01-01T00:00:00Z' }],
  ['UNSUPPORTED_ROUTER', { router: 'unknown' }],
  ['OUTPUT_PROTECTION', { otherAmountThreshold: '994' }],
  ['OUTPUT_PROTECTION', { otherAmountThreshold: '1001' }],
  ['PARAMETER_MISMATCH', { inAmount: '1000001' }],
  ['PROVIDER_REJECTED', { errorCode: 1, error: 'private-provider-detail' }],
])(
  'classifies rejected HTTP-success quotes as %s without returning a quote',
  async (code, patch) => {
    await expect(
      quoteSolanaBuy(
        { outputMint: mint, amount: '0.001' },
        'key',
        AbortSignal.timeout(1000),
        async () => Response.json({ ...result, ...patch }),
      ),
    ).rejects.toMatchObject({
      code,
      message: expect.not.stringContaining('private-provider-detail'),
    });
  },
);
it.each(['null', '[]', '123', '{private-provider-detail'])(
  'sanitizes malformed quote documents',
  async (body) => {
    await expect(
      quoteSolanaBuy(
        { outputMint: mint, amount: '0.001' },
        'key',
        AbortSignal.timeout(1000),
        async () => new Response(body),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: expect.not.stringContaining('private-provider-detail'),
    });
  },
);
it('rejects provider redirects without following a credential-bearing request', async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://untrusted.example/quote' },
      }),
  );
  await expect(
    quoteSolanaBuy(
      { outputMint: mint, amount: '0.001' },
      'server-key',
      AbortSignal.timeout(1000),
      fetcher as typeof fetch,
    ),
  ).rejects.toThrow('unavailable');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]).toEqual([
    expect.any(URL),
    expect.objectContaining({ redirect: 'manual' }),
  ]);
});
it('retains the declared platform fee and rejects inconsistent fee amounts or mint metadata', async () => {
  const input = { outputMint: mint, amount: '0.001' };
  const fee = { feeBps: 2, feeMint: WRAPPED_SOL };
  await expect(
    quoteSolanaBuy(input, 'key', AbortSignal.timeout(1000), async () =>
      Response.json({
        ...result,
        platformFee: fee,
        feeBps: 2,
        feeMint: WRAPPED_SOL,
      }),
    ),
  ).resolves.toMatchObject({ platformFee: { bps: 2, mint: WRAPPED_SOL } });
  for (const values of [
    { platformFee: fee, feeBps: 3 },
    { platformFee: { ...fee, feeMint: '11111111111111111111111111111111' } },
    { feeBps: 2 },
    { platformFee: { ...fee, feeBps: 1.5 } },
  ])
    await expect(
      quoteSolanaBuy(input, 'key', AbortSignal.timeout(1000), async () =>
        Response.json({ ...result, ...values }),
      ),
    ).rejects.toThrow('fee');
});
it('quotes an exact token-to-SOL sell and rejects reversed mint responses', async () => {
  const sell = {
    ...result,
    inputMint: mint,
    outputMint: WRAPPED_SOL,
    inAmount: '1',
    outAmount: '1000',
    otherAmountThreshold: '995',
  };
  const fetcher = vi.fn(async (_url: unknown) => Response.json(sell));
  const quote = await quoteSolanaSell(
    { inputMint: mint, amount: '0.000001', decimals: 6 },
    'key',
    AbortSignal.timeout(1000),
    fetcher as typeof fetch,
  );
  const url = new URL(String(fetcher.mock.calls[0][0]));
  expect(url.searchParams.get('inputMint')).toBe(mint);
  expect(url.searchParams.get('outputMint')).toBe(WRAPPED_SOL);
  expect(url.searchParams.get('amount')).toBe('1');
  expect(url.searchParams.has('taker')).toBe(false);
  expect(quote.side).toBe('Sell');
  expect(quote.inAmount).toBe('1');
  expect(quote.outputMint).toBe(WRAPPED_SOL);
  expect(quote).not.toHaveProperty('transaction');
  await expect(
    quoteSolanaSell(
      { inputMint: mint, amount: '0.000001', decimals: 6 },
      'key',
      AbortSignal.timeout(1000),
      async () =>
        Response.json({ ...sell, inputMint: WRAPPED_SOL, outputMint: mint }),
    ),
  ).rejects.toThrow('parameters');
});
it('quotes a standalone imported buy without wallet or execution material', async () => {
  const fetcher = vi.fn(async (_url: unknown) => Response.json(result));
  const quote = await quoteSolanaBuy(
    { outputMint: mint, amount: '0.001' },
    'key',
    AbortSignal.timeout(1000),
    fetcher as typeof fetch,
  );
  const url = new URL(String(fetcher.mock.calls[0]?.[0]));
  expect(url.searchParams.get('outputMint')).toBe(mint);
  expect(url.searchParams.get('amount')).toBe('1000000');
  expect(url.searchParams.has('taker')).toBe(false);
  expect(quote.executionAllowed).toBe(false);
  expect(quote).not.toHaveProperty('cycle');
  expect(quote).not.toHaveProperty('transaction');
  expect(quote).not.toHaveProperty('requestId');
});
it('rotates token identity by saved cycle and rejects cycles outside the plan', async () => {
  const second = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
  const plan = { ...doc(), tokens: [mint, second] };
  const fetcher = vi.fn(async (url: unknown) =>
    Response.json({
      ...result,
      outputMint: new URL(String(url)).searchParams.get('outputMint'),
    }),
  );
  expect(
    (
      await quoteWarmupBuy(
        plan,
        'key',
        AbortSignal.timeout(1000),
        fetcher as typeof fetch,
        2,
      )
    ).outputMint,
  ).toBe(second);
  expect(
    (
      await quoteWarmupBuy(
        plan,
        'key',
        AbortSignal.timeout(1000),
        fetcher as typeof fetch,
        3,
      )
    ).outputMint,
  ).toBe(mint);
  for (const cycle of [0, 4, 1.5])
    await expect(
      quoteWarmupBuy(
        plan,
        'key',
        AbortSignal.timeout(1000),
        fetcher as typeof fetch,
        cycle,
      ),
    ).rejects.toThrow('cycle');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('sends only quote parameters with a server header and strips signing payloads', async () => {
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = new URL(String(url));
    expect(u.origin + u.pathname).toBe('https://api.jup.ag/swap/v2/order');
    expect(u.searchParams.get('amount')).toBe('1000000');
    expect(u.searchParams.has('taker')).toBe(false);
    expect(u.search).not.toContain('api-secret');
    expect(init?.headers).toEqual({ 'x-api-key': 'api-secret' });
    expect(init?.redirect).toBe('manual');
    return Response.json(result);
  });
  const q = await quoteWarmupBuy(
    doc(),
    'api-secret',
    AbortSignal.timeout(1000),
    fetcher as typeof fetch,
  );
  expect(q.executionAllowed).toBe(false);
  expect(q.minimumOutAmount).toBe('995');
  expect(q).not.toHaveProperty('transaction');
  expect(q).not.toHaveProperty('requestId');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('refuses missing credentials, same-mint swaps and unsupported networks before requests', async () => {
  const fetcher = vi.fn();
  await expect(
    quoteWarmupBuy(doc(), undefined, AbortSignal.timeout(1000), fetcher),
  ).rejects.toThrow();
  await expect(
    quoteWarmupBuy(
      { ...doc(), tokens: [WRAPPED_SOL] },
      'key',
      AbortSignal.timeout(1000),
      fetcher,
    ),
  ).rejects.toThrow();
  await expect(
    quoteWarmupBuy(
      { ...doc(), chain: 'Base' },
      'key',
      AbortSignal.timeout(1000),
      fetcher,
    ),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it('rejects mismatched amounts/pair/slippage, unsafe thresholds, expiry and unsupported routers', async () => {
  for (const patch of [
    { inAmount: '1000001' },
    { outputMint: WRAPPED_SOL },
    { slippageBps: 51 },
    { otherAmountThreshold: '994' },
    { otherAmountThreshold: '1001' },
    { outAmount: '1e3' },
    { router: 'unknown' },
    { expireAt: '2000-01-01T00:00:00Z' },
    { errorCode: 1 },
  ])
    await expect(
      quoteWarmupBuy(doc(), 'key', AbortSignal.timeout(1000), async () =>
        Response.json({ ...result, ...patch }),
      ),
    ).rejects.toThrow();
});
it('shortens RFQ expiry and sanitizes failed provider response messages', async () => {
  const expires = new Date(Date.now() + 10000).toISOString();
  const q = await quoteWarmupBuy(
    doc(),
    'key',
    AbortSignal.timeout(1000),
    async () => Response.json({ ...result, expireAt: expires }),
  );
  expect(q.expiresAt).toBe(expires);
  await expect(
    quoteWarmupBuy(
      doc(),
      'key',
      AbortSignal.timeout(1000),
      async () => new Response('api-secret upstream detail', { status: 401 }),
    ),
  ).rejects.toThrow('authentication failed');
  await expect(
    quoteWarmupBuy(
      doc(),
      'key',
      AbortSignal.timeout(1000),
      async () => new Response('x'.repeat(262145)),
    ),
  ).rejects.toThrow('size limit');
});

it('explains a wallet-bound provider refusal without echoing provider details or retrying', async () => {
  const fetcher = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(
        { error: 'Failed to get quotes: fixture-private-detail' },
        { status: 400 },
      ),
  );
  const error = await prepareSolanaSwap(
    {
      tokenMint: mint,
      side: 'Buy',
      amount: '0.001',
      decimals: 9,
      wallet: '11111111111111111111111111111111',
    },
    'fixture-key',
    AbortSignal.timeout(1000),
    fetcher,
  ).catch((value) => value);
  expect(error).toBeInstanceOf(WarmupQuoteError);
  expect(error.code).toBe('PROVIDER_REJECTED');
  expect(error.message).toContain('Check warmup preflight');
  expect(error.message).toContain(
    'A market quote does not establish wallet readiness',
  );
  expect(error.message).not.toContain('fixture-private-detail');
  expect(fetcher).toHaveBeenCalledTimes(1);
  const requestInput = fetcher.mock.calls[0][0];
  const url =
    requestInput instanceof URL
      ? requestInput
      : new URL(
          typeof requestInput === 'string' ? requestInput : requestInput.url,
        );
  expect(url.searchParams.get('taker')).toBe(
    '11111111111111111111111111111111',
  );
});
it('keeps authentication, rate-limit and market-only failures distinct from wallet preparation', async () => {
  for (const [status, message] of [
    [401, 'authentication failed'],
    [429, 'rate limit reached'],
    [503, 'unavailable or no route'],
  ] as const) {
    await expect(
      prepareSolanaSwap(
        {
          tokenMint: mint,
          side: 'Buy',
          amount: '0.001',
          decimals: 9,
          wallet: '11111111111111111111111111111111',
        },
        'fixture-key',
        AbortSignal.timeout(1000),
        async () => new Response('private upstream body', { status }),
      ),
    ).rejects.toThrow(message);
  }
  await expect(
    quoteWarmupBuy(
      doc(),
      'fixture-key',
      AbortSignal.timeout(1000),
      async () => new Response('private upstream body', { status: 400 }),
    ),
  ).rejects.toThrow('unavailable or no route');
});
