import { describe, it, expect } from 'vitest';
import { fundingTransfers, reviewFundingFees } from './funding-fees';
const funder = '0x1111111111111111111111111111111111111111',
  recipient = '0x2222222222222222222222222222222222222222';
const hash = '0x' + 'a'.repeat(64),
  hex = (value: bigint) => '0x' + value.toString(16),
  word = (value: bigint) => '0x' + value.toString(16).padStart(64, '0');
const input = () => ({
  name: 'Fee fixture',
  chain: 'Base',
  currency: 'ETH',
  source: 'Wallet',
  sourceLabel: 'Public address',
  funderAddress: funder,
  startAt: new Date().toISOString(),
  delaySeconds: 0,
  recipients: [{ address: recipient, amount: '0.000000000000000001' }],
});
function provider(options: Record<string, unknown> = {}) {
  const calls: { method: string; params: unknown[] }[] = [];
  const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const call = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    calls.push(call);
    const result =
      call.method === 'eth_chainId'
        ? (options.chainId ?? '0x2105')
        : call.method === 'eth_getBlockByNumber'
          ? {
              number: '0x64',
              hash:
                call.params[0] === 'latest'
                  ? hash
                  : (options.finalHash ?? hash),
              timestamp: hex(BigInt(Math.floor(Date.now() / 1000))),
            }
          : call.method === 'eth_getBalance'
            ? (options.balance ?? hex(1000000000000000000n))
            : call.method === 'eth_gasPrice'
              ? '0x3b9aca00'
              : call.method === 'eth_estimateGas'
                ? '0x5208'
                : call.params[0].data === '0x313ce567'
                  ? (options.decimals ?? word(18n))
                  : (options.tokenBalance ?? word(1000000000000000000n));
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  }) as typeof fetch;
  return { fetcher, calls };
}
describe('EVM funding fee review', () => {
  it('builds exact native values and ERC-20 calldata without signing fields', () => {
    expect(fundingTransfers(input()).transfers[0].transaction).toEqual({
      from: funder,
      to: recipient,
      value: '0x1',
      data: '0x',
    });
    const token = fundingTransfers({
      ...input(),
      assetAddress: '0x4200000000000000000000000000000000000006',
    });
    expect(token.transfers[0].transaction.data).toBe(
      '0xa9059cbb' +
        recipient.slice(2).padStart(64, '0') +
        '1'.padStart(64, '0'),
    );
    expect(token.transfers[0].transaction.value).toBe('0x0');
    expect(() =>
      fundingTransfers({ ...input(), funderAddress: recipient }),
    ).toThrow('recipient');
    expect(() => fundingTransfers({ ...input(), source: 'CEX' })).toThrow(
      'wallet source',
    );
  });
  it('separates native transfer units from gas and conserves exact required amounts', async () => {
    const { fetcher, calls } = provider();
    const result = await reviewFundingFees(input(), undefined, fetcher);
    expect(result).toMatchObject({
      transferTotal: '0.000000000000000001',
      estimatedFee: '0.000021',
      nativeRequired: '0.000021000000000001',
      nativeShortfall: '0',
      transferShortfall: '0',
    });
    expect(
      calls.find((call) => call.method === 'eth_estimateGas')?.params[1],
    ).toBe('0x64');
    expect(
      calls.find((call) => call.method === 'eth_getBalance')?.params[1],
    ).toEqual({ blockHash: hash, requireCanonical: true });
    expect(
      calls.some(
        (call) => call.method.includes('send') || call.method.includes('sign'),
      ),
    ).toBe(false);
  });
  it('checks contract precision and transfer balance while charging fees in native currency', async () => {
    const { fetcher } = provider();
    const result = await reviewFundingFees(
      {
        ...input(),
        assetAddress: '0x4200000000000000000000000000000000000006',
      },
      undefined,
      fetcher,
    );
    expect(result.contract).toBe('0x4200000000000000000000000000000000000006');
    expect(result.nativeRequired).toBe('0.000021');
    const bad = provider({ decimals: word(6n) });
    await expect(
      reviewFundingFees(
        {
          ...input(),
          assetAddress: '0x4200000000000000000000000000000000000006',
        },
        undefined,
        bad.fetcher,
      ),
    ).rejects.toThrow('decimals');
  });
  it('reports insufficient units without inventing fees and identifies gas shortfalls', async () => {
    const missing = provider({ balance: '0x0' });
    const result = await reviewFundingFees(input(), undefined, missing.fetcher);
    expect(result.transferShortfall).toBe('0.000000000000000001');
    expect(result.estimatedFee).toBeNull();
    expect(
      missing.calls.some((call) => call.method === 'eth_estimateGas'),
    ).toBe(false);
    const feeMissing = provider({ balance: '0x1' });
    expect(
      (await reviewFundingFees(input(), undefined, feeMissing.fetcher))
        .nativeShortfall,
    ).toBe('0.000021');
  });
  it('rejects provider network mismatch and a changed observation block', async () => {
    for (const options of [
      { chainId: '0x1' },
      { finalHash: '0x' + 'b'.repeat(64) },
    ]) {
      const { fetcher } = provider(options);
      await expect(
        reviewFundingFees(input(), undefined, fetcher),
      ).rejects.toThrow();
    }
  });
});
