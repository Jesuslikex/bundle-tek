import { expect, it, vi } from 'vitest';
import { inspectToken, validateTokenSource } from './token-import';
import {
  decodeEvmIdentityText,
  inspectEvmTokenIdentityAtBlock,
} from './evm-token-identity';
import { EVM_NETWORKS, type EvmChain } from './evm-network';
const contract = '0x1111111111111111111111111111111111111111';
const hash = '0x' + 'ab'.repeat(32);
const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
const string = (text: string) => {
  const bytes = Buffer.from(text);
  return (
    '0x' +
    word(32) +
    word(bytes.length) +
    bytes.toString('hex').padEnd(Math.ceil(bytes.length / 32) * 64, '0')
  );
};
function provider(
  chain: EvmChain,
  change?: (method: string, result: unknown, params: unknown[]) => unknown,
) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const fetcher = vi.fn(
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(url).toBe(EVM_NETWORKS[chain].endpoint);
      expect(init?.redirect).toBe('manual');
      const request = JSON.parse(init!.body as string);
      calls.push(request);
      let result: unknown;
      if (request.method === 'eth_chainId')
        result = '0x' + EVM_NETWORKS[chain].id.toString(16);
      else if (request.method === 'eth_getBlockByNumber')
        result = {
          number: '0xabc',
          hash,
          timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
        };
      else if (request.method === 'eth_getCode') result = '0x6000';
      else if (request.method === 'eth_call')
        result = (
          {
            '0x06fdde03': string('USD Coin'),
            '0x95d89b41': string('USDC'),
            '0x313ce567': '0x' + word(6),
            '0x18160ddd': '0x' + word(2n ** 256n - 1n),
          } as Record<string, string>
        )[request.params[0].data];
      else throw new Error('Unexpected method');
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: change
          ? change(request.method, result, request.params)
          : result,
      });
    },
  ) as typeof fetch;
  return { fetcher, calls };
}
it.each(Object.keys(EVM_NETWORKS) as EvmChain[])(
  'reads %s identity and uint256 supply at one canonical block',
  async (chain) => {
    const { fetcher, calls } = provider(chain);
    expect(
      await inspectToken({ chain, address: contract }, fetcher),
    ).toMatchObject({
      chain,
      address: contract,
      name: 'USD Coin',
      symbol: 'USDC',
      decimals: 6,
      totalSupplyRaw: (2n ** 256n - 1n).toString(),
      blockNumber: 2748,
      blockHash: hash,
      source: EVM_NETWORKS[chain].endpoint,
    });
    const pinned = calls.filter((call) =>
      ['eth_call', 'eth_getCode'].includes(call.method),
    );
    expect(pinned).toHaveLength(5);
    expect(
      pinned.every(
        (call) =>
          JSON.stringify(call.params[1]) ===
          JSON.stringify({ blockHash: hash, requireCanonical: true }),
      ),
    ).toBe(true);
    expect(
      calls
        .filter((call) => call.method === 'eth_call')
        .every((call) => (call.params[0] as { gas: string }).gas === '0x186a0'),
    ).toBe(true);
    expect(calls.at(-1)?.params).toEqual(['0xabc', false]);
  },
);
it('reads historical identity from the saved canonical block without falling back to latest', async () => {
  const { fetcher, calls } = provider('Base', (method, result) =>
    method === 'eth_getBlockByNumber'
      ? { ...(result as object), timestamp: '0x5f5e1000' }
      : result,
  );
  expect(
    await inspectEvmTokenIdentityAtBlock(
      { chain: 'Base', address: contract },
      { blockNumber: '2748', blockHash: hash },
      AbortSignal.timeout(1000),
      fetcher,
    ),
  ).toMatchObject({
    name: 'USD Coin',
    decimals: 6,
    blockNumber: 2748,
    blockHash: hash,
  });
  expect(
    calls
      .filter((c) => c.method === 'eth_getBlockByNumber')
      .every((c) => c.params[0] === '0xabc'),
  ).toBe(true);
  expect(
    calls
      .filter((c) => c.method === 'eth_call')
      .every(
        (c) =>
          (c.params[1] as { blockHash: string; requireCanonical: boolean })
            .blockHash === hash,
      ),
  ).toBe(true);
});
it('rejects forged historical anchors and changed final headers', async () => {
  const p = provider('Base');
  await expect(
    inspectEvmTokenIdentityAtBlock(
      { chain: 'Base', address: contract },
      { blockNumber: '2749', blockHash: hash },
      AbortSignal.timeout(1000),
      p.fetcher,
    ),
  ).rejects.toThrow('does not match');
  let headers = 0;
  const changed = provider('Base', (method, result) =>
    method === 'eth_getBlockByNumber' && ++headers === 2
      ? { ...(result as object), number: '0xabd' }
      : result,
  );
  await expect(
    inspectEvmTokenIdentityAtBlock(
      { chain: 'Base', address: contract },
      { blockNumber: '2748', blockHash: hash },
      AbortSignal.timeout(1000),
      changed.fetcher,
    ),
  ).rejects.toThrow('changed');
  for (const blockNumber of ['-1', '01', '9007199254740992'])
    expect(() =>
      inspectEvmTokenIdentityAtBlock(
        { chain: 'Base', address: contract },
        { blockNumber, blockHash: hash },
        AbortSignal.timeout(1000),
        p.fetcher,
      ),
    ).toThrow();
});
it('accepts bounded UTF8 and legacy bytes32 identity, rejects malformed ABI and control text', () => {
  expect(decodeEvmIdentityText(string('Café'))).toBe('Café');
  expect(
    decodeEvmIdentityText(
      '0x' + Buffer.from('OLD').toString('hex').padEnd(64, '0'),
    ),
  ).toBe('OLD');
  for (const value of [
    '0x',
    '0x01',
    string('bad\u0001'),
    string('x'.repeat(257)),
    string('Name').slice(0, -2),
    '0x' + word(64) + string('Name').slice(66),
    '0x' + Buffer.from('A\0B').toString('hex').padEnd(64, '0'),
    '0x' + word(32) + word(1) + 'ff'.padEnd(64, '0'),
  ])
    expect(() => decodeEvmIdentityText(value)).toThrow();
});
it.each(['network', 'stale', 'code', 'decimals', 'supply', 'reorg'])(
  'rejects %s without copying token identity',
  async (kind) => {
    const { fetcher } = provider('Base', (method, result, params) => {
      if (kind === 'network' && method === 'eth_chainId') return '0x1';
      if (kind === 'stale' && method === 'eth_getBlockByNumber')
        return { ...(result as object), timestamp: '0x1' };
      if (kind === 'code' && method === 'eth_getCode') return '0x';
      if (
        kind === 'decimals' &&
        method === 'eth_call' &&
        (params[0] as { data: string }).data === '0x313ce567'
      )
        return '0x' + word(256);
      if (
        kind === 'supply' &&
        method === 'eth_call' &&
        (params[0] as { data: string }).data === '0x18160ddd'
      )
        return '0x0';
      if (
        kind === 'reorg' &&
        method === 'eth_getBlockByNumber' &&
        params[0] !== 'latest'
      )
        return { ...(result as object), hash: '0x' + 'cd'.repeat(32) };
      return result;
    });
    await expect(
      inspectToken({ chain: 'Base', address: contract }, fetcher),
    ).rejects.toThrow();
  },
);
it('rejects unknown networks and addresses before contacting a provider', async () => {
  const fetcher = vi.fn() as typeof fetch;
  for (const chain of ['https://attacker.test', 'Polygon', 'BNB'])
    await expect(
      inspectToken({ chain, address: 'invalid' }, fetcher),
    ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  expect(() =>
    validateTokenSource({
      chain: 'Base',
      address: '0xA114f757fae463fb737ef88bbafc6c3f502c430d',
    }),
  ).toThrow('checksum');
});
