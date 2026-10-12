import { expect, it, vi } from 'vitest';
import { encodeAbiParameters } from 'viem';
import { importedTokenDocument } from './imported-token-project';
import bs58 from 'bs58';
import {
  decodeMetaplexIdentity,
  inspectToken,
  METADATA_PROGRAM,
  TOKEN_READ_RPC,
  validateTokenSource,
} from './token-import';
import { validateProjectDocument } from './workspace-project';
import { DEFAULT_LAUNCH_PLAN } from './launch-plan';
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
function metadata(name = 'USD Coin', symbol = 'USDC') {
  const text = (s: string) => {
    const b = Buffer.from(s);
    const n = Buffer.alloc(4);
    n.writeUInt32LE(b.length);
    return Buffer.concat([n, b]);
  };
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.alloc(32),
    Buffer.from(bs58.decode(mint)),
    text(name),
    text(symbol),
    text('https://example.com/token.json'),
  ]).toString('base64');
}
const account = {
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
};
type TestResult = {
  context: { slot: number };
  value: {
    owner: string;
    executable: boolean;
    data: typeof account.data | string[];
  } | null;
};
function provider(change?: (value: TestResult, call: number) => void) {
  let call = 0;
  return vi.fn(
    async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = JSON.parse(init!.body as string);
      expect(request.method).toBe('getAccountInfo');
      const result: TestResult = structuredClone(
        ++call === 1
          ? { context: { slot: 100 }, value: account }
          : {
              context: { slot: 101 },
              value: {
                owner: METADATA_PROGRAM,
                executable: false,
                data: [metadata(), 'base64'],
              },
            },
      );
      change?.(result, call);
      return Response.json({ result });
    },
  ) as unknown as typeof fetch;
}
it('reads initialized mint and matching metadata with exact supply and no arbitrary metadata fetch', async () => {
  const fetcher = provider();
  const token = await inspectToken({ chain: 'Solana', address: mint }, fetcher);
  expect(token).toMatchObject({
    name: 'USD Coin',
    symbol: 'USDC',
    totalSupplyRaw: '12345678901234567890',
    decimals: 6,
    tokenProgram: account.owner,
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(
    vi.mocked(fetcher).mock.calls.every((call) => call[0] === TOKEN_READ_RPC),
  ).toBe(true);
  const params = JSON.parse(
    vi.mocked(fetcher).mock.calls[1][1]!.body as string,
  ).params;
  expect(params[1].minContextSlot).toBe(100);
});
it.each(['owner', 'mint', 'slot', 'supply', 'missing'])(
  'rejects invalid %s instead of creating token identity',
  async (kind) => {
    const fetcher = provider((result, n) => {
      if (kind === 'owner' && n === 1)
        result.value!.owner = '11111111111111111111111111111111';
      if (kind === 'mint' && n === 2) {
        const bytes = Buffer.from(metadata(), 'base64');
        bytes[33] ^= 1;
        (result.value!.data as string[])[0] = bytes.toString('base64');
      }
      if (kind === 'slot' && n === 2) result.context.slot = 99;
      if (kind === 'supply' && n === 1)
        (result.value!.data as typeof account.data).parsed.info.supply =
          '18446744073709551616';
      if (kind === 'missing' && n === 2) result.value = null;
    });
    await expect(
      inspectToken({ chain: 'Solana', address: mint }, fetcher),
    ).rejects.toThrow();
  },
);
it('rejects truncated Borsh and oversized fields', () => {
  expect(() => decodeMetaplexIdentity(metadata('x'.repeat(33)), mint)).toThrow(
    'length',
  );
  expect(() =>
    decodeMetaplexIdentity(metadata().slice(0, 100), mint),
  ).toThrow();
});
it('rejects wrong source networks and keeps only validated clone provenance in saved documents', () => {
  expect(() =>
    validateTokenSource({ chain: 'Ethereum', address: mint }),
  ).toThrow();
  expect(() =>
    validateTokenSource({ chain: 'Solana', address: 'https://example.com' }),
  ).toThrow();
  const document = validateProjectDocument({
    plan: DEFAULT_LAUNCH_PLAN,
    identity: {
      clonedFrom: { chain: 'Solana', address: mint, privateKey: 'ignored' },
    },
  });
  expect(document.identity.clonedFrom).toEqual({
    chain: 'Solana',
    address: mint,
  });
  expect(() =>
    validateProjectDocument({
      plan: DEFAULT_LAUNCH_PLAN,
      identity: { clonedFrom: { chain: 'Solana', address: 'invalid' } },
    }),
  ).toThrow();
});
it('bounds provider responses and rejects redirects', async () => {
  await expect(
    inspectToken(
      { chain: 'Solana', address: mint },
      vi.fn(async () => new Response('x'.repeat(262145))) as typeof fetch,
    ),
  ).rejects.toThrow('limit');
  await expect(
    inspectToken(
      { chain: 'Solana', address: mint },
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'http://localhost' },
          }),
      ) as typeof fetch,
    ),
  ).rejects.toThrow('unavailable');
});

it('passes real EVM reader provenance into the saved import contract without exposing an RPC path', async () => {
  const source = {
    chain: 'Base' as const,
    address: '0x4200000000000000000000000000000000000006',
  };
  const header = {
    number: '0x7b',
    hash: '0x' + 'a'.repeat(64),
    timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
  };
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (typeof init?.body !== 'string')
      throw new Error('Expected JSON RPC request body.');
    const body = JSON.parse(init.body) as {
      method: string;
      params: Array<{ data?: string }>;
    };
    let result: unknown;
    if (body.method === 'eth_chainId') result = '0x2105';
    else if (body.method === 'eth_getBlockByNumber') result = header;
    else if (body.method === 'eth_getCode') result = '0x6000';
    else if (body.method === 'eth_call') {
      const selector = body.params[0].data;
      result =
        selector === '0x06fdde03'
          ? encodeAbiParameters([{ type: 'string' }], ['Wrapped Ether'])
          : selector === '0x95d89b41'
            ? encodeAbiParameters([{ type: 'string' }], ['WETH'])
            : encodeAbiParameters(
                [{ type: 'uint256' }],
                [selector === '0x313ce567' ? 18n : 123n],
              );
    }
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  });
  const token = await inspectToken(source, fetcher as typeof fetch);
  const document = importedTokenDocument(source, token);
  expect(token.source).toBe('https://mainnet.base.org');
  expect(document.token.source).toBe('mainnet.base.org');
  expect(document.token.address).toBe(source.address);
  expect(document.token.decimals).toBe(18);
});
