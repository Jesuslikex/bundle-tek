import { expect, it } from 'vitest';
import {
  discoverEvmTransactions,
  appendDiscovery,
  olderDiscoveryAnchor,
} from './evm-transaction-discovery';
import { EVM_NETWORKS } from './evm-network';
import { ERC20_TRANSFER_TOPIC } from './evm-transfer-logs';
const address = '0x1111111111111111111111111111111111111111',
  other = '0x2222222222222222222222222222222222222222';
const hash = (n: number) => '0x' + n.toString(16).padStart(64, '0');
it('discovers indirect token participants only in explicit receipt mode and binds older mode', async () => {
  const p = provider(),
    calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const request = JSON.parse(init!.body as string);
    calls.push(request.method);
    if (request.method !== 'eth_getBlockReceipts') return p.fetcher(url, init);
    const n = Number(BigInt(request.params[0])),
      word = (s: string) => '0x' + s.slice(2).padStart(64, '0');
    return Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: Array.from({ length: 3 }, (_, i) => ({
        transactionHash: hash(100 + n * 3 + i),
        blockHash: hash(n),
        blockNumber: '0x' + n.toString(16),
        transactionIndex: '0x' + i.toString(16),
        from: i === 0 ? address : other,
        to: i === 1 ? address : other,
        status: '0x1',
        logs:
          i === 2
            ? [
                {
                  address: other,
                  transactionHash: hash(102 + n * 3),
                  blockHash: hash(n),
                  blockNumber: '0x' + n.toString(16),
                  transactionIndex: '0x2',
                  logIndex: '0x0',
                  removed: false,
                  topics: [ERC20_TRANSFER_TOPIC, word(other), word(address)],
                  data: word('0x1'),
                },
              ]
            : [],
      })),
    });
  };
  const result = await discoverEvmTransactions(
    'Base',
    address,
    AbortSignal.timeout(2000),
    fetcher,
    undefined,
    true,
  );
  expect(result.includesTokenEvents).toBe(true);
  expect(result.matchingEventCount).toBe(10);
  expect(result.candidates).toHaveLength(30);
  expect(result.candidates[0]).toMatchObject({
    direction: 'Token events',
    transactionIndex: '2',
    transferEvents: [{ raw: '1', direction: 'Incoming' }],
  });
  expect(calls.filter((m) => m === 'eth_getBlockReceipts')).toHaveLength(10);
  const direct = await discoverEvmTransactions(
    'Base',
    address,
    AbortSignal.timeout(2000),
    p.fetcher,
  );
  expect(direct.candidates).toHaveLength(20);
  expect(() =>
    appendDiscovery(result, {
      ...direct,
      toBlock: '9',
      blockHash: hash(9),
      fromBlock: '0',
      observedAt: new Date(Date.parse(result.observedAt) + 1).toISOString(),
    }),
  ).toThrow();
});
it('continues from saved parent anchors, appends pages and preserves per-read provenance', async () => {
  const initial = await discoverEvmTransactions(
    'Base',
    address,
    AbortSignal.timeout(2000),
    provider().fetcher,
  );
  const anchor = olderDiscoveryAnchor(initial);
  expect(anchor).toMatchObject({
    number: '9',
    hash: hash(9),
    childNumber: '10',
    childHash: hash(10),
    originalNumber: '19',
    originalHash: hash(19),
  });
  const older = await discoverEvmTransactions(
    'Base',
    address,
    AbortSignal.timeout(2000),
    provider().fetcher,
    anchor,
  );
  const appended = appendDiscovery(initial, {
    ...older,
    observedAt: new Date(Date.parse(initial.observedAt) + 1).toISOString(),
  });
  expect(appended).toMatchObject({
    fromBlock: '0',
    toBlock: '19',
    blocksScanned: 20,
    transactionsScanned: 60,
    blockHash: hash(19),
  });
  expect(appended.candidates).toHaveLength(40);
  expect(appended.pages).toHaveLength(2);
  expect(appended.pages![0].observedAt).toBe(initial.observedAt);
  expect(() => olderDiscoveryAnchor(appended)).toThrow('limit');
  expect(() => appendDiscovery(initial, { ...older, toBlock: '10' })).toThrow();
  expect(() =>
    appendDiscovery(initial, { ...older, observedAt: initial.observedAt }),
  ).toThrow();
  expect(() =>
    olderDiscoveryAnchor({ ...initial, pages: Array(20).fill(initial) }),
  ).toThrow();
  expect(() =>
    olderDiscoveryAnchor({ ...initial, fromParentHash: '' }),
  ).toThrow();
});
it('rejects reorganized retained branches and wrong older anchors', async () => {
  const initial = await discoverEvmTransactions(
      'Base',
      address,
      AbortSignal.timeout(2000),
      provider().fetcher,
    ),
    anchor = olderDiscoveryAnchor(initial);
  await expect(
    discoverEvmTransactions(
      'Base',
      address,
      AbortSignal.timeout(2000),
      provider().fetcher,
      { ...anchor, hash: hash(999) },
    ),
  ).rejects.toThrow('branch changed');
  for (const target of ['0xa', '0x13']) {
    const p = provider('Base', (r, f) => {
      if (!f && r.number === target) r.hash = hash(999);
    });
    await expect(
      discoverEvmTransactions(
        'Base',
        address,
        AbortSignal.timeout(2000),
        p.fetcher,
        anchor,
      ),
    ).rejects.toThrow('branch changed');
  }
});
function provider(
  chain: keyof typeof EVM_NETWORKS = 'Base',
  mutate: (row: Record<string, unknown>, full: boolean) => void = () => {},
) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const timestamp = Math.floor(Date.now() / 1000);
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(init!.body as string);
    calls.push(request);
    if (request.method === 'eth_chainId')
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: '0x' + EVM_NETWORKS[chain].id.toString(16),
      });
    const n =
      request.params[0] === 'latest' ? 19 : Number(BigInt(request.params[0]));
    const row: Record<string, unknown> = {
      number: '0x' + n.toString(16),
      hash: hash(n),
      parentHash: hash(Math.max(0, n - 1)),
      timestamp: '0x' + (timestamp - (19 - n) * 2).toString(16),
      transactions: [],
    };
    if (request.params[1])
      row.transactions = [
        {
          hash: hash(100 + n * 3),
          blockHash: hash(n),
          blockNumber: row.number,
          transactionIndex: '0x0',
          from: address,
          to: other,
          value: '0x20000000000001',
          chainId: '0x' + EVM_NETWORKS[chain].id.toString(16),
        },
        {
          hash: hash(101 + n * 3),
          blockHash: hash(n),
          blockNumber: row.number,
          transactionIndex: '0x1',
          from: other,
          to: address,
          value: '0x0',
        },
        {
          hash: hash(102 + n * 3),
          blockHash: hash(n),
          blockNumber: row.number,
          transactionIndex: '0x2',
          from: other,
          to: other,
          value: '0x1',
        },
      ];
    mutate(row, request.params[1]);
    return Response.json({ jsonrpc: '2.0', id: 1, result: row });
  };
  return { fetcher, calls };
}
it('discovers ordered direct matches with exact values and a ten-block canonical window on all networks', async () => {
  for (const chain of Object.keys(EVM_NETWORKS) as Array<
    keyof typeof EVM_NETWORKS
  >) {
    const p = provider(chain);
    const result = await discoverEvmTransactions(
      chain,
      address,
      AbortSignal.timeout(2000),
      p.fetcher,
    );
    expect(result).toMatchObject({
      chain,
      address,
      fromBlock: '10',
      toBlock: '19',
      blocksScanned: 10,
      transactionsScanned: 30,
      currency: EVM_NETWORKS[chain].currency,
    });
    expect(result.candidates).toHaveLength(20);
    expect(result.candidates[0]).toMatchObject({
      direction: 'Incoming',
      transactionIndex: '1',
      blockNumber: '19',
      valueRaw: '0',
    });
    expect(result.candidates[1]).toMatchObject({
      direction: 'Outgoing',
      valueRaw: '9007199254740993',
      value: '0.009007199254740993',
    });
    expect(
      p.calls.filter((c) => c.method === 'eth_getBlockByNumber'),
    ).toHaveLength(12);
  }
});
it('rejects changed anchors, broken parent links, incomplete blocks, stale time and forged transaction context', async () => {
  const mutations: Array<(r: Record<string, unknown>, full: boolean) => void> =
    [
      (r, f) => {
        if (f && r.number === '0x13')
          r.timestamp = '0x' + (Math.floor(Date.now() / 1000) - 1).toString(16);
      },
      (r, f) => {
        if (f && r.number === '0x13') r.hash = hash(999);
      },
      (r, f) => {
        if (f && r.number === '0x12') r.parentHash = hash(999);
      },
      (r, f) => {
        if (f) r.transactions = null;
      },
      (r) => {
        r.timestamp = '0x' + (Math.floor(Date.now() / 1000) - 901).toString(16);
      },
      (r, f) => {
        if (f)
          (r.transactions as Record<string, unknown>[])[0].blockHash =
            hash(999);
      },
      (r, f) => {
        if (f)
          (r.transactions as Record<string, unknown>[])[0].transactionIndex =
            '0x1';
      },
      (r, f) => {
        if (f) (r.transactions as Record<string, unknown>[])[0].chainId = '0x1';
      },
      (r, f) => {
        if (f) (r.transactions as Record<string, unknown>[])[0].value = '0x00';
      },
      (r, f) => {
        if (f) (r.transactions as Record<string, unknown>[])[0].from = 'bad';
      },
    ];
  for (const mutate of mutations)
    await expect(
      discoverEvmTransactions(
        'Base',
        address,
        AbortSignal.timeout(2000),
        provider('Base', mutate).fetcher,
      ),
    ).rejects.toThrow();
  let headers = 0;
  const p = provider('Base', (r, f) => {
    if (!f && ++headers === 2)
      r.timestamp = '0x' + (Math.floor(Date.now() / 1000) - 1).toString(16);
  });
  await expect(
    discoverEvmTransactions(
      'Base',
      address,
      AbortSignal.timeout(2000),
      p.fetcher,
    ),
  ).rejects.toThrow('anchor changed');
});
it('preserves self and creation matches, bounds results, aborts and allows a zero recipient without admitting a zero roster address', async () => {
  const p = provider('Base', (r, f) => {
    if (f) {
      const txs = r.transactions as Record<string, unknown>[];
      txs[0].to = address;
      txs[1].from = address;
      txs[1].to = null;
      txs[2].to = '0x' + '0'.repeat(40);
    }
  });
  const result = await discoverEvmTransactions(
    'Base',
    address,
    AbortSignal.timeout(2000),
    p.fetcher,
  );
  expect(result.candidates[0].to).toBeNull();
  expect(result.candidates[1].direction).toBe('Self');
  const many = provider('Base', (r, f) => {
    if (f) {
      r.transactions = Array.from({ length: 101 }, (_, i) => ({
        ...(r.transactions as Record<string, unknown>[])[0],
        hash: hash(10000 + Number(BigInt(r.number as string)) * 101 + i),
        transactionIndex: '0x' + i.toString(16),
      }));
    }
  });
  await expect(
    discoverEvmTransactions(
      'Base',
      address,
      AbortSignal.timeout(2000),
      many.fetcher,
    ),
  ).rejects.toThrow('Too many');
  await expect(
    discoverEvmTransactions('Base', address, AbortSignal.abort(), p.fetcher),
  ).rejects.toThrow();
  await expect(
    discoverEvmTransactions(
      'Base',
      '0x' + '0'.repeat(40),
      AbortSignal.timeout(2000),
      p.fetcher,
    ),
  ).rejects.toThrow();
});
