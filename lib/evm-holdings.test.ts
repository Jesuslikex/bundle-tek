import { describe, it, expect } from 'vitest';
import { observeEvmHoldings, validateEvmHoldingsRequest } from './evm-holdings';
const address = '0x1111111111111111111111111111111111111111';
const contract = '0x2222222222222222222222222222222222222222';
const hash = '0x' + 'a'.repeat(64);
const word = (value: bigint) => '0x' + value.toString(16).padStart(64, '0');
function provider(patch: Record<string, unknown> = {}) {
  const calls: { method: string; params: unknown[] }[] = [];
  const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const call = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    calls.push(call);
    const result =
      call.method === 'eth_chainId'
        ? (patch.chainId ?? '0x1')
        : call.method === 'eth_getBlockByNumber'
          ? {
              number: '0x64',
              hash: patch.hash ?? hash,
              timestamp:
                '0x' + Math.floor((Date.now() - 1000) / 1000).toString(16),
              ...(patch.header as Record<string, unknown>),
            }
          : call.params[0].data === '0x313ce567'
            ? (patch.decimals ?? word(6n))
            : (patch.balance ?? word(9007199254740993n));
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  }) as typeof fetch;
  return { fetcher, calls };
}
describe('EVM selected-contract balances', () => {
  it('rejects holdings when the canonical block changes after the contract reads', async () => {
    const base = provider();
    let headers = 0;
    const fetcher: typeof fetch = async (url, init) => {
      const call = JSON.parse(
        typeof init?.body === 'string' ? init.body : '{}',
      );
      if (call.method === 'eth_getBlockByNumber' && ++headers === 2)
        return Response.json({
          jsonrpc: '2.0',
          id: 1,
          result: { hash: '0x' + 'b'.repeat(64) },
        });
      return base.fetcher(url, init);
    };
    await expect(
      observeEvmHoldings(
        { chain: 'Ethereum', address, contracts: [contract] },
        undefined,
        fetcher,
      ),
    ).rejects.toThrow('Holdings block changed');
  });
  it('preserves uint256 amounts and pins every call to the same canonical block', async () => {
    const { fetcher, calls } = provider();
    const result = await observeEvmHoldings(
      { chain: 'Ethereum', address, contracts: [contract] },
      undefined,
      fetcher,
    );
    expect(result.holdings).toEqual([
      {
        contract,
        raw: '9007199254740993',
        decimals: 6,
        amount: '9007199254.740993',
      },
    ]);
    expect(result.blockHash).toBe(hash);
    const reads = calls.filter((call) => call.method === 'eth_call');
    expect(reads).toHaveLength(2);
    expect(reads[0].params[0]).toEqual({
      to: contract,
      data: '0x70a08231' + address.slice(2).padStart(64, '0'),
      gas: '0x186a0',
    });
    for (const read of reads)
      expect(read.params[1]).toEqual({
        blockHash: hash,
        requireCanonical: true,
      });
  });
  it('admits all five EVM networks and rejects malformed, duplicate or oversized lists', () => {
    for (const chain of ['Ethereum', 'Base', 'BNB', 'Arc', 'Robinhood'])
      expect(
        validateEvmHoldingsRequest({ chain, address, contracts: [contract] })
          .chain,
      ).toBe(chain);
    for (const contracts of [
      [],
      [contract, contract],
      [address, 'not-a-contract'],
      Array(21).fill(contract),
    ])
      expect(() =>
        validateEvmHoldingsRequest({ chain: 'Ethereum', address, contracts }),
      ).toThrow();
    expect(() =>
      validateEvmHoldingsRequest({
        chain: 'Solana',
        address,
        contracts: [contract],
      }),
    ).toThrow();
  });
  it('rejects wrong networks, stale headers, missing ABI words and invalid decimals without returning partial inventory', async () => {
    for (const patch of [
      { chainId: '0x38' },
      { hash: 'bad' },
      { header: { timestamp: '0x1' } },
      { balance: '0x' },
      { balance: word(1n) + '00' },
      { decimals: word(256n) },
    ]) {
      const { fetcher } = provider(patch);
      await expect(
        observeEvmHoldings(
          { chain: 'Ethereum', address, contracts: [contract] },
          undefined,
          fetcher,
        ),
      ).rejects.toThrow();
    }
  });
  it('retains zero observations and the largest uint256 without rounding', async () => {
    const { fetcher } = provider({
      balance: word((1n << 256n) - 1n),
      decimals: word(18n),
    });
    expect(
      (
        await observeEvmHoldings(
          { chain: 'Ethereum', address, contracts: [contract] },
          undefined,
          fetcher,
        )
      ).holdings[0].raw,
    ).toBe(((1n << 256n) - 1n).toString());
    const zero = provider({ balance: word(0n), decimals: word(0n) });
    expect(
      (
        await observeEvmHoldings(
          { chain: 'Ethereum', address, contracts: [contract] },
          undefined,
          zero.fetcher,
        )
      ).holdings[0],
    ).toMatchObject({ raw: '0', amount: '0', decimals: 0 });
  });
});
