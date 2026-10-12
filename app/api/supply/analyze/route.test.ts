import { describe, expect, it, vi, beforeEach } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/lib/solana-rpc', async (original) => ({
  ...(await original<typeof import('@/lib/solana-rpc')>()),
  getSolanaHolderRpcEndpoint: () => 'https://fixture.test',
  rpcCall: rpc,
}));
import { POST } from '@/app/api/supply/analyze/route';
import { supplyWallet } from '@/test/supply-history-fixture';
import { TOKEN_PROGRAMS } from '@/lib/wallet-holdings';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
const mint = supplyWallet(9),
  owner = supplyWallet(1),
  address = supplyWallet(2);
const account = {
  owner: TOKEN_PROGRAMS[0],
  executable: false,
  data: {
    parsed: {
      type: 'account',
      info: {
        mint,
        owner,
        state: 'initialized',
        tokenAmount: { amount: '400', decimals: 0 },
      },
    },
  },
};
beforeEach(() => rpc.mockReset());
it('identifies failed largest-account reads without returning partial rankings or provider text', async () => {
  rpc
    .mockResolvedValueOnce(SOLANA_MAINNET_GENESIS)
    .mockResolvedValueOnce({
      context: { slot: 100 },
      value: { amount: '1000', decimals: 0 },
    })
    .mockRejectedValueOnce(
      new Error('Provider disabled method, api-key=SYNTHETIC_SECRET'),
    );
  const response = await POST(request());
  expect(response.status).toBe(502);
  const body = (await response.json()) as {
    code: string;
    error: string;
    topExternal?: unknown;
  };
  expect(body.code).toBe('HOLDER_RPC_UNAVAILABLE');
  expect(body.error).toContain('getTokenLargestAccounts');
  expect(body.error).not.toContain('SYNTHETIC_SECRET');
  expect(body.topExternal).toBeUndefined();
});
const request = () =>
  new Request('https://bundle.test/api/supply/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mint, bundleWallets: [] }),
  });
function replies(details: unknown = account) {
  rpc
    .mockResolvedValueOnce(SOLANA_MAINNET_GENESIS)
    .mockResolvedValueOnce({
      context: { slot: 100 },
      value: { amount: '1000', decimals: 0 },
    })
    .mockResolvedValueOnce({
      context: { slot: 101 },
      value: [{ address, amount: '400', decimals: 0 }],
    })
    .mockResolvedValueOnce({ context: { slot: 102 }, value: [details] });
}
it('publishes verified sampled wallet owners with consistent supply', async () => {
  replies();
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    totalSupply: '1000',
    topExternal: [{ owner, amount: '400', supplyPercent: 40 }],
  });
});
it('withholds results when account owner metadata is missing', async () => {
  replies(null);
  expect((await POST(request())).status).toBe(502);
});
it('does not reflect provider credential text into the response', async () => {
  rpc.mockRejectedValueOnce(
    new Error('https://provider.test/?api-key=SYNTHETIC_SECRET'),
  );
  const response = await POST(request());
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain('SYNTHETIC_SECRET');
});

describe('POST /api/supply/analyze', () => {
  it('returns 400 for malformed JSON', async () => {
    const request = new Request('https://bundle.test/api/supply/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'INVALID_JSON',
    });
  });
});
