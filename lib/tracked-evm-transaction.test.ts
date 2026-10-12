import { it, expect } from 'vitest';
import { observeEvmTransaction } from './tracked-evm-transaction';
import { EVM_NETWORKS } from './evm-network';
import { ERC20_TRANSFER_TOPIC } from './evm-transfer-logs';
const address = '0x1111111111111111111111111111111111111111',
  other = '0x2222222222222222222222222222222222222222';
const hash = '0x' + 'a'.repeat(64),
  blockHash = '0x' + 'b'.repeat(64);
function provider(patch: Record<string, unknown> = {}, finalPatch = {}) {
  const tx = {
    hash,
    blockHash,
    blockNumber: '0x12',
    transactionIndex: '0x0',
    from: address,
    to: other,
    value: '0x20000000000001',
    gas: '0x5208',
    input: '0x12345678',
    chainId: '0x2105',
  };
  const receipt = {
    transactionHash: hash,
    blockHash,
    blockNumber: '0x12',
    transactionIndex: '0x0',
    from: address,
    to: other,
    status: '0x1',
    gasUsed: '0x5208',
    effectiveGasPrice: '0x1',
    logs: [],
  };
  const header = {
    hash: blockHash,
    number: '0x12',
    timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
    transactions: [hash],
  };
  const results = {
    eth_chainId: '0x2105',
    eth_getTransactionByHash: tx,
    eth_getTransactionReceipt: receipt,
    eth_getBlockByNumber: header,
    ...patch,
  };
  let headers = 0;
  const methods: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    if (typeof init?.body !== 'string') throw new Error('Expected JSON');
    const request = JSON.parse(init.body) as { method: keyof typeof results };
    methods.push(request.method);
    let result = results[request.method];
    if (request.method === 'eth_getBlockByNumber' && ++headers === 2)
      result = { ...header, ...finalPatch };
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  };
  return { tx, receipt, header, fetcher, methods };
}
const inspect = (p: ReturnType<typeof provider>, wallet = address) =>
  observeEvmTransaction(
    'Base',
    wallet,
    hash,
    AbortSignal.timeout(1000),
    p.fetcher,
  );
it('binds all five supported networks and their native currency', async () => {
  for (const [chain, network] of Object.entries(EVM_NETWORKS)) {
    const base = provider();
    const p = provider({
      eth_chainId: '0x' + network.id.toString(16),
      eth_getTransactionByHash: {
        ...base.tx,
        chainId: '0x' + network.id.toString(16),
      },
    });
    expect(
      await observeEvmTransaction(
        chain,
        address,
        hash,
        AbortSignal.timeout(1000),
        p.fetcher,
      ),
    ).toMatchObject({ chain, currency: network.currency });
  }
});
it('retains exact native units and execution gas cost while binding receipt and block membership', async () => {
  const p = provider();
  const r = await inspect(p);
  expect(r).toMatchObject({
    valueRaw: '9007199254740993',
    value: '0.009007199254740993',
    executionGasCostRaw: '21000',
    blockHash,
    direction: 'Outgoing',
    status: 'Succeeded',
    selector: '0x12345678',
    inputBytes: 4,
  });
  expect(p.methods.filter((m) => m === 'eth_getBlockByNumber')).toHaveLength(2);
  expect(p.methods.some((m) => /sign|send/i.test(m))).toBe(false);
});
it('supports incoming, self, reverted and creation transactions without claiming net change', async () => {
  const incoming = provider();
  expect((await inspect(incoming, other))?.direction).toBe('Incoming');
  const base = provider();
  const self = provider({
    eth_getTransactionByHash: { ...base.tx, to: address },
    eth_getTransactionReceipt: { ...base.receipt, to: address, status: '0x0' },
  });
  expect(await inspect(self)).toMatchObject({
    direction: 'Self',
    status: 'Reverted',
  });
  const creation = provider({
    eth_getTransactionByHash: { ...base.tx, to: null },
    eth_getTransactionReceipt: { ...base.receipt, to: null },
  });
  expect((await inspect(creation))?.to).toBeNull();
});
it('returns unavailable for absent or pending receipts', async () => {
  expect(
    await inspect(provider({ eth_getTransactionReceipt: null })),
  ).toBeNull();
  const base = provider();
  await expect(
    inspect(
      provider({ eth_getTransactionByHash: { ...base.tx, blockHash: null } }),
    ),
  ).rejects.toThrow();
});
it('rejects unrelated addresses and wrong network before saving', async () => {
  await expect(
    inspect(provider(), '0x3333333333333333333333333333333333333333'),
  ).rejects.toThrow('involve');
  await expect(inspect(provider({ eth_chainId: '0x1' }))).rejects.toThrow(
    'Wrong transaction network',
  );
});
it('admits a token-event recipient while keeping the enclosing transaction value separate', async () => {
  const indirect = '0x3333333333333333333333333333333333333333',
    base = provider();
  const topic = (a: string) => '0x' + a.slice(2).padStart(64, '0');
  const log = {
    address: other,
    transactionHash: hash,
    blockHash,
    blockNumber: '0x12',
    transactionIndex: '0x0',
    logIndex: '0x1',
    removed: false,
    topics: [ERC20_TRANSFER_TOPIC, topic(other), topic(indirect)],
    data: '0x' + '0'.repeat(63) + '1',
  };
  const p = provider({
    eth_getTransactionReceipt: { ...base.receipt, logs: [log] },
  });
  expect(await inspect(p, indirect)).toMatchObject({
    direction: 'Token events',
    directParticipant: false,
    valueRaw: '9007199254740993',
    transferEvents: [{ direction: 'Incoming', raw: '1', logIndex: '1' }],
    receiptLogCount: 1,
  });
  await expect(
    inspect(
      provider({
        eth_getTransactionReceipt: {
          ...base.receipt,
          logs: [{ ...log, topics: [...log.topics, topic(other)], data: '0x' }],
        },
      }),
      indirect,
    ),
  ).rejects.toThrow('involve');
  await expect(
    inspect(
      provider({
        eth_getTransactionReceipt: { ...base.receipt, logs: undefined },
      }),
    ),
  ).rejects.toThrow('logs');
});
it('rejects mismatched receipt hashes, indices, participants, status, gas and noncanonical quantities', async () => {
  const base = provider();
  for (const patch of [
    { transactionHash: blockHash },
    { blockHash: hash },
    { blockNumber: '0x13' },
    { transactionIndex: '0x1' },
    { from: other },
    { status: '0x2' },
    { gasUsed: '0x5209' },
    { effectiveGasPrice: '0x01' },
  ])
    await expect(
      inspect(
        provider({ eth_getTransactionReceipt: { ...base.receipt, ...patch } }),
      ),
    ).rejects.toThrow();
});
it('rejects missing canonical membership, future time and changed final block', async () => {
  const base = provider();
  for (const patch of [
    { transactions: [] },
    { transactions: [blockHash] },
    { hash },
    { timestamp: '0xffffffffffffffff' },
  ])
    await expect(
      inspect(provider({ eth_getBlockByNumber: { ...base.header, ...patch } })),
    ).rejects.toThrow();
  await expect(inspect(provider({}, { hash }))).rejects.toThrow('changed');
});
