import { describe, it, expect, vi } from 'vitest';
import {
  EVM_BALANCE_NETWORKS,
  observeWalletBalances,
  SOLANA_MAINNET_GENESIS,
  parseBalanceJson,
} from './wallet-balances';
import { combinedWalletBalance } from './wallet-balance-format';
const sol = [
  '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
  '8phnoC6V8nwYnNUwobNBoWzWAmyP1nj9GyYZaMbU8z4',
];
const evm = [
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
];
const blockHash = `0x${'ab'.repeat(32)}`;
const envelope = (result: unknown) =>
  Response.json({ jsonrpc: '2.0', id: 1, result });
const rpcBody = (init?: RequestInit) => {
  if (typeof init?.body !== 'string') throw new Error('RPC JSON body required');
  return JSON.parse(init.body);
};
function evmProvider(
  chain: keyof typeof EVM_BALANCE_NETWORKS,
  patch: Record<string, unknown> = {},
) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(url).toBe(EVM_BALANCE_NETWORKS[chain].endpoint);
    expect(init?.redirect).toBe('manual');
    const body = rpcBody(init);
    calls.push(body);
    const results: Record<string, unknown> = {
      eth_chainId: `0x${EVM_BALANCE_NETWORKS[chain].id.toString(16)}`,
      eth_getBlockByNumber: {
        number: '0xc',
        hash: blockHash,
        timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
      },
      eth_getBalance:
        body.params[0] === evm[0] ? '0xde0b6b3a7640001' : '0x1bc16d674ec80000',
      ...patch,
    };
    return envelope(results[body.method]);
  }) as typeof fetch;
  return { fetcher, calls };
}
describe('native wallet balance observations', () => {
  it('preserves Solana u64 precision and uses one ordered account snapshot', async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = rpcBody(init);
        calls.push(body.method);
        if (body.method === 'getGenesisHash')
          return envelope(SOLANA_MAINNET_GENESIS);
        expect(body.params).toEqual([
          sol,
          {
            commitment: 'confirmed',
            encoding: 'base64',
            dataSlice: { offset: 0, length: 0 },
          },
        ]);
        return new Response(
          '{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":200},"value":[{"lamports":9007199254740993},null]}}',
        );
      },
    ) as typeof fetch;
    const snapshot = await observeWalletBalances(
      'Solana',
      sol,
      undefined,
      fetcher,
    );
    expect(snapshot).toMatchObject({
      total: '9007199.254740993',
      currency: 'SOL',
      blockNumber: 200,
      commitment: 'confirmed',
    });
    expect(snapshot.items.map((b) => b.raw)).toEqual(['9007199254740993', '0']);
    expect(
      snapshot.items.every((b) => b.snapshotId === snapshot.snapshotId),
    ).toBe(true);
    expect(calls).toEqual(['getGenesisHash', 'getMultipleAccounts']);
    expect(parseBalanceJson('{"v":18446744073709551615}')).toEqual({
      v: '18446744073709551615',
    });
  });
  it.each(['Robinhood', 'BNB', 'Arc', 'Ethereum', 'Base'] as const)(
    'checks %s and pins every balance to one canonical block hash',
    async (chain) => {
      const { fetcher, calls } = evmProvider(chain);
      const result = await observeWalletBalances(
        chain,
        evm,
        undefined,
        fetcher,
      );
      expect(result).toMatchObject({
        total: '3.000000000000000001',
        currency: EVM_BALANCE_NETWORKS[chain].currency,
        blockNumber: 12,
        blockHash,
      });
      expect(result.items[0].amount).toBe('1.000000000000000001');
      expect(
        calls
          .filter((c) => c.method === 'eth_getBalance')
          .map((c) => c.params[1]),
      ).toEqual([
        { blockHash, requireCanonical: true },
        { blockHash, requireCanonical: true },
      ]);
      expect(
        calls.every((c) =>
          ['eth_chainId', 'eth_getBlockByNumber', 'eth_getBalance'].includes(
            c.method,
          ),
        ),
      ).toBe(true);
    },
  );
  it('fails closed on wrong networks, stale blocks and malformed EVM quantities', async () => {
    for (const patch of [
      { eth_chainId: '0x38' },
      {
        eth_getBlockByNumber: {
          number: '0xc',
          hash: blockHash,
          timestamp: '0x1',
        },
      },
      { eth_getBalance: '0x01' },
      { eth_getBalance: `0x1${'0'.repeat(64)}` },
    ])
      await expect(
        observeWalletBalances(
          'Ethereum',
          evm,
          undefined,
          evmProvider('Ethereum', patch).fetcher,
        ),
      ).rejects.toThrow();
    const bad = vi.fn(async () => envelope('wrong-network')) as typeof fetch;
    await expect(
      observeWalletBalances('Solana', sol, undefined, bad),
    ).rejects.toThrow(/network mismatch/);
    expect(bad).toHaveBeenCalledTimes(1);
  });
  it('rejects incomplete, fractional and oversized Solana integer balances', async () => {
    for (const value of [
      '[{"lamports":1}]',
      '[{"lamports":1.5},null]',
      '[{"lamports":18446744073709551616},null]',
      '[{"lamports":1e3},null]',
    ]) {
      const fetcher = vi.fn(
        async (_url: RequestInfo | URL, init?: RequestInit) =>
          rpcBody(init).method === 'getGenesisHash'
            ? envelope(SOLANA_MAINNET_GENESIS)
            : new Response(
                `{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":200},"value":${value}}}`,
              ),
      ) as typeof fetch;
      await expect(
        observeWalletBalances('Solana', sol, undefined, fetcher),
      ).rejects.toThrow();
    }
  });
  it('rejects redirects, oversized bodies and mismatched JSON-RPC envelopes', async () => {
    for (const response of [
      new Response(null, { status: 302 }),
      new Response('x'.repeat(524289)),
      Response.json({ jsonrpc: '2.0', id: 2, result: '0x1' }),
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: 'unsupported block hash' },
      }),
    ]) {
      const fetcher = vi.fn(async () => response) as typeof fetch;
      await expect(
        observeWalletBalances('Ethereum', evm, undefined, fetcher),
      ).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('does not combine missing observations or independent snapshots into a total', async () => {
    const snapshot = await observeWalletBalances(
      'Ethereum',
      evm,
      undefined,
      evmProvider('Ethereum').fetcher,
    );
    const wallets = evm.map((address) => ({
      address,
      chain: 'Ethereum' as const,
    }));
    expect(combinedWalletBalance(wallets, snapshot.items)?.amount).toBe(
      '3.000000000000000001',
    );
    expect(
      combinedWalletBalance(wallets, snapshot.items.slice(0, 1)),
    ).toBeNull();
    expect(
      combinedWalletBalance(
        wallets,
        snapshot.items.map((b, i) =>
          i ? { ...b, snapshotId: 'different' } : b,
        ),
      ),
    ).toBeNull();
  });
});
