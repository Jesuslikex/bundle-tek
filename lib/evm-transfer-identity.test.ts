import { it, expect } from 'vitest';
import { encodeAbiParameters } from 'viem';
import {
  observeTransferIdentities,
  transferEventAmount,
} from './evm-transfer-identity';
import type { EvmTransactionObservation } from './tracked-evm-transaction';
const contract = '0x1111111111111111111111111111111111111111',
  failed = '0x2222222222222222222222222222222222222222',
  hash = '0x' + 'b'.repeat(64);
const tx = {
  chain: 'Base',
  blockNumber: '17',
  blockHash: hash,
  transferEvents: [{ contract }, { contract }, { contract: failed }],
} as EvmTransactionObservation;
it('deduplicates contract reads, pins old block identity, and leaves unsupported metadata unavailable', async () => {
  const calls: { method: string; params: unknown[] }[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    if (typeof init?.body !== 'string') throw new Error('Expected JSON');
    const b = JSON.parse(init.body);
    calls.push(b);
    const result =
      b.method === 'eth_chainId'
        ? '0x2105'
        : b.method === 'eth_getBlockByNumber'
          ? { number: '0x11', hash, timestamp: '0x5f5e1000' }
          : b.method === 'eth_getCode'
            ? '0x6000'
            : b.params[0].data === '0x06fdde03'
              ? encodeAbiParameters([{ type: 'string' }], ['USD Coin'])
              : b.params[0].data === '0x95d89b41'
                ? encodeAbiParameters([{ type: 'string' }], ['USDC'])
                : encodeAbiParameters(
                    [{ type: 'uint256' }],
                    [b.params[0].data === '0x313ce567' ? 6n : 100n],
                  );
    return Response.json(
      b.method === 'eth_getCode' && b.params[0] === failed
        ? {
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32000, message: 'private-provider-error' },
          }
        : { jsonrpc: '2.0', id: 1, result },
    );
  };
  const report = await observeTransferIdentities(
    tx,
    AbortSignal.timeout(1000),
    fetcher,
  );
  expect(report.identities).toMatchObject([
    { contract, symbol: 'USDC', decimals: 6, blockHash: hash, blockNumber: 17 },
  ]);
  expect(report.unavailable).toEqual([failed]);
  expect(JSON.stringify(report)).not.toContain('private-provider-error');
  expect(
    calls.filter((c) => c.method === 'eth_getCode' && c.params[0] === contract),
  ).toHaveLength(1);
  expect(
    calls
      .filter((c) => c.method === 'eth_call')
      .every(
        (c) =>
          JSON.stringify(c.params[1]) ===
          JSON.stringify({ blockHash: hash, requireCanonical: true }),
      ),
  ).toBe(true);
  expect(transferEventAmount('2000000', report.identities[0])).toBe('2');
  expect(
    transferEventAmount('9007199254740993', {
      ...report.identities[0],
      decimals: 0,
    }),
  ).toBe('9007199254740993');
  expect(
    transferEventAmount('1', { ...report.identities[0], decimals: 255 }),
  ).toBe('0.' + '0'.repeat(254) + '1');
});
it('rejects absent events, excess contracts and aborts without saving partial identity results', async () => {
  await expect(
    observeTransferIdentities(
      { ...tx, transferEvents: [] },
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow();
  await expect(
    observeTransferIdentities(
      {
        ...tx,
        transferEvents: Array.from({ length: 21 }, (_, i) => ({
          contract: '0x' + i.toString(16).padStart(40, '0'),
        })),
      } as EvmTransactionObservation,
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow('20');
  const c = new AbortController();
  c.abort();
  await expect(observeTransferIdentities(tx, c.signal)).rejects.toThrow();
});
