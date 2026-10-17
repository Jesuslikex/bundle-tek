import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  rpc: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/lib/solana-rpc', () => ({
  getSolanaHolderRpcEndpoint: () => 'https://rpc.test',
  rpcCall: (_e: string, method: string, params: unknown[]) =>
    mocks.rpc(method, params),
}));
import { POST } from './route';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';

const origin = 'https://bundle.test';
const A = 'Vote111111111111111111111111111111111111111';
const post = (body: unknown, headers: Record<string, string> = { origin }) =>
  POST(
    new Request(origin + '/api/supply/bubble-map', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
beforeEach(() => {
  mocks.user = { userId: 'alice' };
  mocks.rpc
    .mockReset()
    .mockImplementation(async (method: string) =>
      method === 'getGenesisHash'
        ? SOLANA_MAINNET_GENESIS
        : method === 'getSignaturesForAddress'
          ? []
          : null,
    );
});

it('needs a signed-in same-origin request with 1 to 20 distinct addresses', async () => {
  mocks.user = null;
  expect((await post({ addresses: [A] })).status).toBe(401);
  mocks.user = { userId: 'alice' };
  expect((await post({ addresses: [A] }, {})).status).toBe(403);
  expect((await post({ addresses: [] })).status).toBe(400);
  expect((await post({ addresses: [A, A] })).status).toBe(400);
  expect((await post({ addresses: ['x'] })).status).toBe(400);
  expect((await post({ addresses: [A], extra: 1 })).status).toBe(400);
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it('reads funders on mainnet only, using read-only methods', async () => {
  const ok = await post({ addresses: [A] });
  expect(await ok.json()).toEqual({
    network: 'mainnet',
    funders: { [A]: { funder: null } },
  });
  expect(new Set(mocks.rpc.mock.calls.map((c) => c[0]))).toEqual(
    new Set(['getGenesisHash', 'getSignaturesForAddress']),
  );
  mocks.rpc.mockResolvedValueOnce('devnet');
  expect((await post({ addresses: [A] })).status).toBe(502);
});
