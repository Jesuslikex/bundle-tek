import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { env } from '@/lib/server-env';
import { createWarmupTokenInspector } from './wallet-warmup-token-identity';
import { inspectWarmupPreflight } from './wallet-warmup-preflight';
import { METADATA_PROGRAM } from './token-import';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { paceWalletRpc } from './wallet-rpc-pacing';

vi.mock('./wallet-rpc-pacing', () => ({
  paceWalletRpc: vi.fn(async () => {}),
}));
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const wallet = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
const configured =
  'https://rpc.example.invalid/private-key?api-key=fixture-secret';
const source = { chain: 'Solana', address: mint };
const signal = () => AbortSignal.timeout(10000);

function metadata(name = 'USD Coin', matchingMint = mint) {
  const text = (value: string, length: number) => {
    const bytes = Buffer.alloc(length);
    bytes.write(value);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(length);
    return Buffer.concat([size, bytes]);
  };
  // Real-shaped padded Borsh prefix and account length, synthetic throughout.
  const result = Buffer.alloc(679);
  Buffer.concat([
    Buffer.from([4]),
    Buffer.alloc(32, 7),
    Buffer.from(bs58.decode(matchingMint)),
    text(name, 32),
    text('USDC', 10),
    text('', 200),
  ]).copy(result);
  return result.toString('base64');
}
function provider(
  options: {
    genesis?: string;
    slot?: number;
    lamports?: number;
    name?: string;
    metadata?: string;
  } = {},
) {
  return vi.fn(
    async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = JSON.parse(init!.body as string);
      let result: unknown;
      if (request.method === 'getGenesisHash')
        result = options.genesis ?? SOLANA_MAINNET_GENESIS;
      else if (request.method === 'getMultipleAccounts')
        result = {
          context: { slot: 100 },
          value: [{ lamports: options.lamports ?? 6000000 }],
        };
      else if (request.method === 'getAccountInfo')
        result = {
          context: {
            slot:
              request.params[1].encoding === 'jsonParsed'
                ? 100
                : (options.slot ?? 101),
          },
          value:
            request.params[1].encoding === 'jsonParsed'
              ? {
                  owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                  executable: false,
                  data: {
                    parsed: {
                      type: 'mint',
                      info: {
                        isInitialized: true,
                        decimals: 6,
                        supply: '12345678901234567890',
                      },
                    },
                  },
                }
              : {
                  owner: METADATA_PROGRAM,
                  executable: false,
                  data: [options.metadata ?? metadata(options.name), 'base64'],
                },
        };
      else throw new Error('Unexpected synthetic RPC method');
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    },
  );
}
const methods = (fetcher: ReturnType<typeof provider>) =>
  fetcher.mock.calls.map(([, init]) => JSON.parse(init!.body as string).method);
beforeEach(() => {
  env.SOLANA_MAINNET_RPC_URL = configured;
  vi.mocked(paceWalletRpc).mockClear();
});
afterEach(() => {
  delete env.SOLANA_MAINNET_RPC_URL;
});

it('uses the configured provider for genesis, mint and padded USDC metadata, returning no private URL', async () => {
  const fetcher = provider();
  const token = await createWarmupTokenInspector(signal(), fetcher)(source);
  expect(token).toMatchObject({
    name: 'USD Coin',
    symbol: 'USDC',
    decimals: 6,
    totalSupplyRaw: '12345678901234567890',
    metadataUri: '',
    source: 'rpc.example.invalid',
  });
  expect(JSON.stringify(token)).not.toMatch(
    /private-key|fixture-secret|api-key/,
  );
  expect(methods(fetcher)).toEqual([
    'getGenesisHash',
    'getAccountInfo',
    'getAccountInfo',
  ]);
  expect(
    fetcher.mock.calls.every(
      ([url, init]) =>
        url === configured &&
        init?.redirect === 'manual' &&
        init.cache === 'no-store',
    ),
  ).toBe(true);
  expect(vi.mocked(paceWalletRpc)).toHaveBeenCalledTimes(3);
  const last = JSON.parse(fetcher.mock.calls[2][1]!.body as string);
  expect(last.params[1].minContextSlot).toBe(100);
});

it('shares only the network check within one preflight and pins its captured endpoint', async () => {
  const underlying = provider();
  const fetcher = vi.fn(
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      env.SOLANA_MAINNET_RPC_URL = 'https://changed.example.invalid';
      return underlying(url, init);
    },
  );
  const inspect = createWarmupTokenInspector(signal(), fetcher);
  const tokens = await Promise.all([inspect(source), inspect(source)]);
  expect(tokens.every((t) => t.source === 'rpc.example.invalid')).toBe(true);
  expect(
    methods(underlying).filter((m) => m === 'getGenesisHash'),
  ).toHaveLength(1);
  expect(underlying.mock.calls).toHaveLength(5);
  expect(underlying.mock.calls.every(([url]) => url === configured)).toBe(true);
});

it('does not inspect accounts or retry after a network mismatch', async () => {
  const fetcher = provider({ genesis: 'wrong-network' });
  const inspect = createWarmupTokenInspector(signal(), fetcher);
  await expect(inspect(source)).rejects.toThrow('network mismatch');
  await expect(inspect(source)).rejects.toThrow('network mismatch');
  expect(methods(fetcher)).toEqual(['getGenesisHash']);
});

it.each([
  ['https://user:password@rpc.example.invalid'],
  ['https://rpc.example.invalid/#fragment'],
  ['file:///tmp/rpc'],
])('refuses invalid configured destination %s', async (endpoint) => {
  env.SOLANA_MAINNET_RPC_URL = endpoint;
  const fetcher = provider();
  await expect(
    createWarmupTokenInspector(signal(), fetcher)(source),
  ).rejects.toThrow('configured token provider');
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([
  [132, true],
  [133, false],
  [99, false],
])('retains the exact slot boundary at %i', async (slot, accepted) => {
  const result = createWarmupTokenInspector(
    signal(),
    provider({ slot }),
  )(source);
  if (accepted) expect((await result).contextSlot).toBe(slot);
  else await expect(result).rejects.toThrow('slots');
});

it.each(['metadata mint', 'embedded control character'])(
  'keeps strict rejection of %s',
  async (kind) => {
    const encoded =
      kind === 'metadata mint'
        ? metadata('USD Coin', wallet)
        : metadata('USD\u0000Coin');
    await expect(
      createWarmupTokenInspector(
        signal(),
        provider({ metadata: encoded }),
      )(source),
    ).rejects.toThrow();
  },
);

it('never starts a read for an already cancelled check', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetcher = provider();
  await expect(
    createWarmupTokenInspector(controller.signal, fetcher)(source),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it('does not start account reads after cancellation during a non-cooperative genesis read', async () => {
  const controller = new AbortController();
  const fetcher = vi.fn(async () => {
    controller.abort();
    return Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: SOLANA_MAINNET_GENESIS,
    });
  });
  await expect(
    createWarmupTokenInspector(controller.signal, fetcher)(source),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('does not follow a late mint response with metadata after cancellation', async () => {
  const controller = new AbortController();
  const underlying = provider();
  const fetcher = vi.fn(
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (JSON.parse(init!.body as string).method === 'getAccountInfo') {
        controller.abort();
        expect(init!.signal!.aborted).toBe(true);
      }
      return underlying(url, init);
    },
  );
  await expect(
    createWarmupTokenInspector(controller.signal, fetcher)(source),
  ).rejects.toThrow();
  expect(methods(underlying)).toEqual(['getGenesisHash', 'getAccountInfo']);
});

it('preserves the existing fallback when no mainnet endpoint is configured', async () => {
  delete env.SOLANA_MAINNET_RPC_URL;
  const fetcher = provider();
  const token = await createWarmupTokenInspector(signal(), fetcher)(source);
  expect(token.source).toBe('solana-rpc.publicnode.com');
  expect(
    fetcher.mock.calls.every(
      ([url]) => url === 'https://solana-rpc.publicnode.com',
    ),
  ).toBe(true);
});

it('stops the preflight inspector on the first 429 without falling back or retrying', async () => {
  const underlying = provider();
  const fetcher = vi.fn(
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      JSON.parse(init!.body as string).method === 'getAccountInfo'
        ? new Response('rate limited', { status: 429 })
        : underlying(url, init),
  );
  const inspect = createWarmupTokenInspector(signal(), fetcher);
  await expect(inspect(source)).rejects.toThrow('rate limited');
  await expect(inspect(source)).rejects.toThrow('rate limited');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([302, 503])(
  'does not follow a failed genesis response (%i)',
  async (status) => {
    const fetcher = vi.fn(
      async () =>
        new Response(null, {
          status,
          headers: { location: 'https://unrelated.example.invalid' },
        }),
    );
    await expect(
      createWarmupTokenInspector(signal(), fetcher)(source),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it.each([302, 503])(
  'cancels the unread account error body (%i) without retrying',
  async (status) => {
    const underlying = provider();
    const cancelled = vi.fn();
    const fetcher = vi.fn(
      async (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
        JSON.parse(init!.body as string).method === 'getAccountInfo'
          ? new Response(new ReadableStream({ cancel: cancelled }), { status })
          : underlying(url, init),
    );
    await expect(
      createWarmupTokenInspector(signal(), fetcher)(source),
    ).rejects.toThrow('unavailable');
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);

it('keeps the decoder response byte cap on the configured endpoint', async () => {
  const underlying = provider();
  const fetcher = vi.fn(
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      JSON.parse(init!.body as string).method === 'getAccountInfo'
        ? new Response('x'.repeat(262145))
        : underlying(url, init),
  );
  await expect(
    createWarmupTokenInspector(signal(), fetcher)(source),
  ).rejects.toThrow('inspection limit');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

const document = () => ({
  name: 'QA',
  chain: 'Solana',
  addresses: [wallet],
  walletRevisions: [{ address: wallet, revision: 1 }],
  tokens: [mint],
  amount: '0.001',
  feeReserve: '0.002',
  cycles: 3,
  intervalMinutes: 60,
  startAt: new Date(Date.now() + 3600000).toISOString(),
  totalBudget: '0.005',
});
it('composes real balance and identity readers into an Observed report without execution authority', async () => {
  const fetcher = provider();
  const report = await inspectWarmupPreflight(document(), signal(), fetcher);
  expect(report).toMatchObject({
    status: 'Observed',
    executionAllowed: false,
    requiredPerWallet: '0.005',
    tokens: [{ address: mint, source: 'rpc.example.invalid', symbol: 'USDC' }],
  });
  expect(report.wallets[0]).toMatchObject({
    amount: '0.006',
    covered: true,
    shortfall: '0',
  });
  expect(fetcher.mock.calls.every(([url]) => url === configured)).toBe(true);
  expect(JSON.stringify(report)).not.toMatch(
    /private-key|fixture-secret|api-key/,
  );
});
it('reports the exact shortfall with valid identity and holds the unfunded wallet', async () => {
  const report = await inspectWarmupPreflight(
    document(),
    signal(),
    provider({ lamports: 0 }),
  );
  expect(report).toMatchObject({ status: 'Hold', executionAllowed: false });
  expect(report.wallets[0]).toMatchObject({
    amount: '0',
    covered: false,
    shortfall: '0.005',
  });
  expect(report.tokens[0].error).toBeUndefined();
});
it('holds a token-only failure while preserving a usable balance and sanitizing its error', async () => {
  const report = await inspectWarmupPreflight(
    document(),
    signal(),
    provider({ name: 'USD\u0000Coin' }),
  );
  expect(report).toMatchObject({ status: 'Hold', executionAllowed: false });
  expect(report.wallets[0].covered).toBe(true);
  expect(report.tokens[0].error).toBe(
    'Token identity unavailable. This token is held from execution.',
  );
  expect(JSON.stringify(report)).not.toMatch(
    /private-key|fixture-secret|api-key/,
  );
});
