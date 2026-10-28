import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  rpc: vi.fn(),
}));
const wallet = 'A1TMhSGzQxMr1TboBKtgixKz1sS6REASMxPo1qsyTSJd';
const id = '00000000-0000-4000-8000-000000000001';
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => ({ userId: 'synthetic-owner' }),
}));
vi.mock('@/lib/server-env', () => ({ env: { JUPITER_API_KEY: 'synthetic' } }));
vi.mock('@/lib/wallet-warmup', async (original) => ({
  ...(await original<typeof import('@/lib/wallet-warmup')>()),
  buildWarmupPlan: () => ({ cycles: 1, addresses: [wallet], tokens: [wallet] }),
  warmupBuyAmount: () => '0.01',
}));
vi.mock('@/lib/warmup-swap-quote', async (original) => ({
  ...(await original<typeof import('@/lib/warmup-swap-quote')>()),
  prepareSolanaSwap: mocks.prepare,
}));
vi.mock('@/lib/wallet-balances', async (original) => ({
  ...(await original<typeof import('@/lib/wallet-balances')>()),
  balanceRpc: mocks.rpc,
}));
vi.mock('@/lib/solana-rpc', () => ({
  getSolanaRpcEndpoint: () => 'https://rpc.example.invalid/synthetic',
}));
vi.mock('@/db', () => ({
  getD1: () => ({
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => sql.includes('warmup_signing_intents')
          ? { id, preparationId: id, wallet, state: 'signed', signature: 'synthetic-signature', failureReceipt: null, document: '{}' }
          : sql.includes('COUNT(*) AS n')
            ? { n: 0 }
            : { document: JSON.stringify({ chain: 'Solana', startAt: new Date().toISOString(), walletRevisions: [{ address: wallet, revision: 1 }] }) },
        run: async () => ({ meta: { changes: 1 } }),
      }),
    }),
  }),
}));
import { POST as prepare } from './prepare/route';
import { POST as signing } from './signing/route';

afterEach(() => {
  vi.restoreAllMocks();
  mocks.prepare.mockReset();
  mocks.rpc.mockReset();
});

it('does not log or expose a thrown provider exception during preparation', async () => {
  const secret = 'https://rpc.example.invalid/private-test-token';
  mocks.prepare.mockRejectedValue(new Error(secret, { cause: new Error('synthetic-private-cause') }));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await prepare(new Request('http://local/prepare', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'qa', revision: 1, cycle: 1, wallet }),
  }));
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: 'Warmup preparation unavailable. No execution clearance.' });
  expect(log.mock.calls).toEqual([['Warmup preparation failed', { stage: 'provider order' }]]);
  expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-private-cause');
});

it('does not log or expose a provider exception disguised as signing guidance', async () => {
  const secret = 'https://rpc.example.invalid/private-test-token';
  mocks.rpc.mockRejectedValue(new Error(`Signing requires ${secret}`, { cause: new Error('synthetic-private-cause') }));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await signing(new Request('http://local/signing', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'recover', id }),
  }));
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: 'Approval recovery unavailable. Keep the registered signature and check its outcome without resending.' });
  expect(log.mock.calls).toEqual([['Warmup approval failed', { stage: 'saved approval' }]]);
  expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-private-cause');
});
