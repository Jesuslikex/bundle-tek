import { it, expect, vi } from 'vitest';
import { balanceRpc } from './wallet-balances';
it('retains the default RPC bound and admits only explicit bounded larger responses', async () => {
  const text = 'x'.repeat(600000),
    provider = vi.fn<typeof fetch>(async () =>
      Response.json({ jsonrpc: '2.0', id: 1, result: text }),
    );
  await expect(
    balanceRpc(
      'https://example.test',
      'eth_getBlockByNumber',
      [],
      AbortSignal.timeout(1000),
      provider,
    ),
  ).rejects.toThrow('too large');
  expect(
    await balanceRpc(
      'https://example.test',
      'eth_getBlockByNumber',
      [],
      AbortSignal.timeout(1000),
      provider,
      2097152,
    ),
  ).toBe(text);
  provider.mockClear();
  for (const limit of [0, -1, 1.2, 2097153, NaN])
    await expect(
      balanceRpc(
        'https://example.test',
        'eth_getBlockByNumber',
        [],
        AbortSignal.timeout(1000),
        provider,
        limit,
      ),
    ).rejects.toThrow('bound');
  expect(provider).not.toHaveBeenCalled();
  const huge: typeof fetch = async () =>
    Response.json({ jsonrpc: '2.0', id: 1, result: 'x'.repeat(2097152) });
  await expect(
    balanceRpc(
      'https://example.test',
      'eth_getBlockByNumber',
      [],
      AbortSignal.timeout(1000),
      huge,
      2097152,
    ),
  ).rejects.toThrow('too large');
});
