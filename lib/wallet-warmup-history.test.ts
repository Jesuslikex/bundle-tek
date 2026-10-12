import { describe, it, expect, vi } from 'vitest';
import { observeWarmupHistory } from './wallet-warmup-history';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
const hash = '0x' + 'a'.repeat(64),
  address = '0x1111111111111111111111111111111111111111';
function provider(results: Record<string, unknown>) {
  const calls: { method: string; params: unknown[] }[] = [];
  const fetcher = vi.fn(
    async (_url: unknown, init: RequestInit | undefined) => {
      if (typeof init?.body !== 'string') throw new Error('JSON body required');
      const b = JSON.parse(init.body);
      calls.push(b);
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: results[b.method],
      });
    },
  ) as unknown as typeof fetch;
  return { fetcher, calls };
}
describe('warmup history observations', () => {
  it('rejects stale, future and missing EVM header times before account reads', async () => {
    // Offsets clear the 900s/300s limits by a minute, so slow runs cannot cross them.
    for (const seconds of [
      Math.floor(Date.now() / 1000) - 960,
      Math.floor(Date.now() / 1000) + 360,
      null,
    ]) {
      const p = provider({
        eth_chainId: '0x2105',
        eth_getBlockByNumber: {
          hash,
          number: '0x12',
          timestamp: seconds === null ? undefined : '0x' + seconds.toString(16),
        },
      });
      await expect(
        observeWarmupHistory(
          'Base',
          address,
          AbortSignal.timeout(1000),
          p.fetcher,
        ),
      ).rejects.toThrow();
      expect(p.calls.some((c) => c.method === 'eth_getBalance')).toBe(false);
    }
  });
  it('rejects a final header with a matching hash but changed block identity', async () => {
    for (const field of ['number', 'timestamp']) {
      let reads = 0;
      const fetcher: typeof fetch = async (_url, init) => {
        if (typeof init?.body !== 'string')
          throw new Error('JSON body required');
        const request = JSON.parse(init.body);
        const header = {
          hash,
          number: '0x12',
          timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
        };
        const result =
          request.method === 'eth_chainId'
            ? '0x2105'
            : request.method === 'eth_getBlockByNumber'
              ? ++reads === 1
                ? header
                : { ...header, [field]: '0x13' }
              : '0x1';
        return Response.json({ jsonrpc: '2.0', id: 1, result });
      };
      await expect(
        observeWarmupHistory(
          'Base',
          address,
          AbortSignal.timeout(1000),
          fetcher,
        ),
      ).rejects.toThrow('Block changed');
    }
  });
  it('rejects unordered Solana samples and malformed failure or balance data', async () => {
    const row = {
      signature: '2'.repeat(88),
      slot: 98,
      blockTime: null,
      err: null,
    };
    const base = {
      getGenesisHash: SOLANA_MAINNET_GENESIS,
      getBalance: { context: { slot: 100 }, value: 1 },
      getSignaturesForAddress: [row],
    };
    for (const patch of [
      {
        getSignaturesForAddress: [
          row,
          { ...row, signature: '3'.repeat(88), slot: 99 },
        ],
      },
      { getSignaturesForAddress: [{ ...row, err: false }] },
      { getSignaturesForAddress: [{ ...row, err: [] }] },
      { getBalance: { context: { slot: 100 }, value: '18446744073709551616' } },
      { getBalance: { context: { slot: 100 }, value: '01' } },
    ]) {
      const p = provider({ ...base, ...patch });
      await expect(
        observeWarmupHistory(
          'Solana',
          '11111111111111111111111111111111',
          AbortSignal.timeout(1000),
          p.fetcher,
        ),
      ).rejects.toThrow();
    }
  });
  it('preserves distinct same-slot Solana records and exact u64 balance', async () => {
    const p = provider({
      getGenesisHash: SOLANA_MAINNET_GENESIS,
      getBalance: { context: { slot: 100 }, value: '18446744073709551615' },
      getSignaturesForAddress: ['2', '3'].map((s) => ({
        signature: s.repeat(88),
        slot: 99,
        blockTime: null,
        err: null,
      })),
    });
    const result = await observeWarmupHistory(
      'Solana',
      '11111111111111111111111111111111',
      AbortSignal.timeout(1000),
      p.fetcher,
    );
    expect(result.sampleCount).toBe(2);
    expect(result.nativeBalance).toBe('18446744073.709551615');
  });
  it('pins EVM reads and retains exact account nonce, leaving age unknown', async () => {
    const p = provider({
      eth_chainId: '0x2105',
      eth_getBlockByNumber: {
        hash,
        number: '0x12',
        timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
      },
      eth_getBalance: '0x1',
      eth_getTransactionCount: '0x20000000000001',
    });
    const r = await observeWarmupHistory(
      'Base',
      address,
      AbortSignal.timeout(1000),
      p.fetcher,
    );
    expect(r.outgoingTransactions).toBe('9007199254740993');
    expect(r.nativeBalance).toBe('0.000000000000000001');
    expect(r.blockHash).toBe(hash);
    expect(r.oldestObservedAt).toBeNull();
    expect(
      p.calls.find((c) => c.method === 'eth_getBalance')?.params[1],
    ).toEqual({ blockHash: hash, requireCanonical: true });
    expect(p.calls.some((c) => /send|sign/i.test(c.method))).toBe(false);
  });
  it('refuses wrong chain and malformed or noncanonical responses', async () => {
    for (const patch of [
      { eth_chainId: '0x1' },
      { eth_getBalance: '0x01' },
      { eth_getBlockByNumber: { hash: 'invalid', number: '0x12' } },
    ]) {
      const p = provider({
        eth_chainId: '0x2105',
        eth_getBlockByNumber: {
          hash,
          number: '0x12',
          timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
        },
        eth_getBalance: '0x1',
        eth_getTransactionCount: '0x1',
        ...patch,
      });
      await expect(
        observeWarmupHistory(
          'Base',
          address,
          AbortSignal.timeout(1000),
          p.fetcher,
        ),
      ).rejects.toThrow();
    }
  });
  it('rejects a block reorganized between the anchored account read and the final header check', async () => {
    let headers = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('JSON body required');
      const request = JSON.parse(init.body);
      const result =
        request.method === 'eth_chainId'
          ? '0x2105'
          : request.method === 'eth_getBlockByNumber'
            ? {
                number: '0x12',
                timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
                hash: ++headers === 1 ? hash : '0x' + 'b'.repeat(64),
              }
            : '0x1';
      return Response.json({ jsonrpc: '2.0', id: 1, result });
    };
    await expect(
      observeWarmupHistory('Base', address, AbortSignal.timeout(1000), fetcher),
    ).rejects.toThrow('Block changed');
  });
  it('distinguishes successful Solana sampled activity from unknown age', async () => {
    const rows = [
      { signature: '2'.repeat(88), slot: 99, blockTime: 1700000000, err: null },
      {
        signature: '3'.repeat(88),
        slot: 98,
        blockTime: null,
        err: { InstructionError: [] },
      },
    ];
    const p = provider({
      getGenesisHash: SOLANA_MAINNET_GENESIS,
      getBalance: { context: { slot: 100 }, value: 1 },
      getSignaturesForAddress: rows,
    });
    const r = await observeWarmupHistory(
      'Solana',
      '11111111111111111111111111111111',
      AbortSignal.timeout(1000),
      p.fetcher,
    );
    expect(r.sampleCount).toBe(2);
    expect(r.successfulSampleCount).toBe(1);
    expect(r.oldestObservedAt).toBe('2023-11-14T22:13:20.000Z');
    expect(r.nativeBalance).toBe('0.000000001');
    expect(r.outgoingTransactions).toBeNull();
  });
  it('does not invent activity from empty or malformed Solana samples', async () => {
    const base = {
      getGenesisHash: SOLANA_MAINNET_GENESIS,
      getBalance: { context: { slot: 100 }, value: 1 },
    };
    const empty = provider({ ...base, getSignaturesForAddress: [] });
    expect(
      (
        await observeWarmupHistory(
          'Solana',
          '11111111111111111111111111111111',
          AbortSignal.timeout(1000),
          empty.fetcher,
        )
      ).oldestObservedAt,
    ).toBeNull();
    for (const row of [
      { signature: '2'.repeat(88), slot: 101, blockTime: null, err: null },
      { signature: 'x', slot: 1, blockTime: null, err: null },
      { signature: '2'.repeat(88), slot: 1, blockTime: -1, err: null },
    ]) {
      const p = provider({ ...base, getSignaturesForAddress: [row] });
      await expect(
        observeWarmupHistory(
          'Solana',
          '11111111111111111111111111111111',
          AbortSignal.timeout(1000),
          p.fetcher,
        ),
      ).rejects.toThrow();
    }
  });
});
