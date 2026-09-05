import { it, expect, vi } from 'vitest';
import { safeRpcFetch } from './runtime';
it('rejects RPC redirects and oversize replies and forbids mutating methods', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('', {
      status: 302,
      headers: { location: 'https://evil.test' },
    }),
  );
  await expect(
    safeRpcFetch('https://rpc.mainnet.chain.robinhood.com', {
      method: 'POST',
      body: JSON.stringify({ method: 'eth_chainId' }),
    }),
  ).rejects.toThrow();
  expect(f.mock.calls[0][1]?.redirect).toBe('manual');
  f.mockClear();
  await expect(
    safeRpcFetch('https://rpc.mainnet.chain.robinhood.com', {
      method: 'POST',
      body: JSON.stringify({ method: 'eth_sendRawTransaction' }),
    }),
  ).rejects.toThrow();
  expect(f).not.toHaveBeenCalled();
  f.mockResolvedValue(new Response('x'.repeat(1048577)));
  await expect(
    safeRpcFetch('https://rpc.mainnet.chain.robinhood.com', {
      method: 'POST',
      body: JSON.stringify({ method: 'eth_chainId' }),
    }),
  ).rejects.toThrow();
  f.mockRestore();
});
