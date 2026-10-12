import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareUnsignedFunding } from './funding-transactions';
const funder = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const hash = '0x' + 'a'.repeat(64);
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
const hex = (n: bigint) => '0x' + n.toString(16);
const input = () => ({
  name: 'Unsigned fixture',
  chain: 'Base',
  currency: 'ETH',
  source: 'Wallet',
  sourceLabel: 'Public funder',
  funderAddress: funder,
  startAt: new Date(Date.now() - 1000).toISOString(),
  delaySeconds: 0,
  recipients: [{ address: recipient, amount: '0.000000000000000001' }],
});
function provider(options: Record<string, unknown> = {}) {
  const calls: { method: string; params: unknown[] }[] = [];
  let headers = 0,
    pending = 0,
    chains = 0,
    gasPrices = 0;
  const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body !== 'string')
      throw new Error('Expected a JSON RPC body.');
    const call = JSON.parse(init.body);
    calls.push(call);
    let result: unknown;
    switch (call.method) {
      case 'eth_chainId':
        result = ++chains > 1 ? (options.finalChain ?? '0x2105') : '0x2105';
        break;
      case 'eth_getBlockByNumber':
        result = {
          number: '0x64',
          hash: ++headers >= 4 ? (options.finalHash ?? hash) : hash,
          timestamp: hex(BigInt(Math.floor(Date.now() / 1000))),
          gasLimit: options.blockGasLimit ?? '0x1c9c380',
        };
        break;
      case 'eth_getBalance':
        result = options.balance ?? hex(10n ** 18n);
        break;
      case 'eth_gasPrice':
        result =
          ++gasPrices > 1
            ? (options.finalGasPrice ?? '0x3b9aca00')
            : '0x3b9aca00';
        break;
      case 'eth_estimateGas':
        result = options.gas ?? '0x5208';
        break;
      case 'eth_getTransactionCount':
        result =
          call.params[1] === 'pending'
            ? ++pending > 1
              ? (options.finalNonce ?? options.nonce ?? '0x10')
              : (options.pendingNonce ?? options.nonce ?? '0x10')
            : (options.nonce ?? '0x10');
        break;
      case 'eth_getCode':
        result =
          call.params[0] === funder
            ? (options.funderCode ?? '0x')
            : (options.recipientCode ?? '0x');
        break;
      case 'eth_call':
        if (call.params[0].data === '0x313ce567') result = word(18n);
        else if (call.params[0].data.startsWith('0x70a08231'))
          result = options.tokenBalance ?? word(10n ** 18n);
        else {
          if (options.expire) vi.setSystemTime(Date.now() + 61000);
          result =
            call.params[0].data === '0x'
              ? '0x'
              : (options.simulation ?? word(1n));
        }
        break;
      default:
        throw new Error('Unexpected read method');
    }
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  }) as typeof fetch;
  return { fetcher, calls };
}
afterEach(() => vi.useRealTimers());
describe('unsigned funding preparation', () => {
  it('conserves native values, assigns consecutive nonces and budgets buffered gas without signing or sending', async () => {
    const { fetcher, calls } = provider();
    const result = await prepareUnsignedFunding(
      {
        ...input(),
        recipients: [
          ...input().recipients,
          {
            address: '0x3333333333333333333333333333333333333333',
            amount: '0.000000000000000002',
          },
        ],
      },
      undefined,
      fetcher,
    );
    expect(result).toMatchObject({
      version: 1,
      executionAllowed: false,
      signed: false,
      chainId: 8453,
      startingNonce: '16',
      maximumGasFee: '0.0000504',
      nativeRequired: '0.000050400000000003',
    });
    expect(
      result.transactions.map((item) => [
        item.transaction.nonce,
        item.transaction.value,
        item.transaction.gas,
      ]),
    ).toEqual([
      ['0x10', '0x1', '0x6270'],
      ['0x11', '0x2', '0x6270'],
    ]);
    expect(result.transactions[0].transaction).toMatchObject({
      type: '0x0',
      chainId: '0x2105',
      from: funder,
      to: recipient,
      data: '0x',
      gasPrice: '0x3b9aca00',
    });
    expect(Date.parse(result.expiresAt) - Date.parse(result.preparedAt)).toBe(
      60_000,
    );
    expect(result.draftHash).toMatch(/^[0-9a-f]{64}$/);
    expect(calls.some((call) => /send|sign/i.test(call.method))).toBe(false);
    expect(
      calls.find((call) => call.method === 'eth_getTransactionCount')
        ?.params[1],
    ).toEqual({ blockHash: hash, requireCanonical: true });
  });
  it('retains exact token calldata and refuses a false token transfer simulation', async () => {
    const draft = {
      ...input(),
      assetAddress: '0x4200000000000000000000000000000000000006',
    };
    const result = await prepareUnsignedFunding(
      draft,
      undefined,
      provider().fetcher,
    );
    expect(result.nativeRequired).toBe('0.0000252');
    expect(result.transactions[0].transaction).toMatchObject({
      to: draft.assetAddress,
      value: '0x0',
      data:
        '0xa9059cbb' +
        recipient.slice(2).padStart(64, '0') +
        '1'.padStart(64, '0'),
    });
    await expect(
      prepareUnsignedFunding(
        draft,
        undefined,
        provider({ simulation: word(0n) }).fetcher,
      ),
    ).rejects.toThrow('simulation');
  });
  it('rejects transfer and buffered-gas shortfalls rather than exporting an underfunded packet', async () => {
    await expect(
      prepareUnsignedFunding(
        input(),
        undefined,
        provider({ balance: '0x0' }).fetcher,
      ),
    ).rejects.toThrow('balance');
    await expect(
      prepareUnsignedFunding(
        input(),
        undefined,
        provider({ balance: hex(21_000n * 10n ** 9n + 1n) }).fetcher,
      ),
    ).rejects.toThrow('20%');
  });
  it('refuses pending/changing nonces and uses exact integers beyond JavaScript precision', async () => {
    await expect(
      prepareUnsignedFunding(
        input(),
        undefined,
        provider({ pendingNonce: '0x11' }).fetcher,
      ),
    ).rejects.toThrow('pending');
    await expect(
      prepareUnsignedFunding(
        input(),
        undefined,
        provider({ finalNonce: '0x11' }).fetcher,
      ),
    ).rejects.toThrow('changed');
    await expect(
      prepareUnsignedFunding(
        input(),
        undefined,
        provider({ nonce: '0xffffffffffffffff' }).fetcher,
      ),
    ).rejects.toThrow('account limit');
    const result = await prepareUnsignedFunding(
      input(),
      undefined,
      provider({ nonce: '0x20000000000001' }).fetcher,
    );
    expect(result.startingNonce).toBe('9007199254740993');
    expect(result.transactions[0].transaction.nonce).toBe('0x20000000000001');
  });
  it('rejects contract/delegated funders and recipients, excessive gas and future scheduling', async () => {
    for (const options of [
      { funderCode: '0xef0100' },
      { recipientCode: '0x6000' },
      { blockGasLimit: '0x5208' },
    ])
      await expect(
        prepareUnsignedFunding(input(), undefined, provider(options).fetcher),
      ).rejects.toThrow();
    const fixture = provider();
    await expect(
      prepareUnsignedFunding(
        { ...input(), delaySeconds: 1 },
        undefined,
        fixture.fetcher,
      ),
    ).rejects.toThrow('immediate');
    await expect(
      prepareUnsignedFunding(
        { ...input(), startAt: new Date(Date.now() + 60000).toISOString() },
        undefined,
        fixture.fetcher,
      ),
    ).rejects.toThrow('immediate');
    expect(fixture.calls).toHaveLength(0);
  });
  it('rejects changed canonical blocks, network and increased gas quotes before export', async () => {
    for (const options of [
      { finalHash: '0x' + 'b'.repeat(64) },
      { finalChain: '0x1' },
      { finalGasPrice: '0x77359400' },
    ])
      await expect(
        prepareUnsignedFunding(input(), undefined, provider(options).fetcher),
      ).rejects.toThrow('changed');
  });
  it('withholds a packet that expires during simulation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await expect(
      prepareUnsignedFunding(
        input(),
        undefined,
        provider({ expire: true }).fetcher,
      ),
    ).rejects.toThrow('expired');
  });
});
