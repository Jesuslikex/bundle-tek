import { afterEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';

const mocks = vi.hoisted(() => ({
  failDatabase: false,
  secret: 'https://rpc.synthetic.invalid/FAKE_TOKEN',
  prepareCleanup: vi.fn(),
  prepareBuy: vi.fn(),
  recoveryRow: null as null | Record<string, unknown>,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => ({ userId: 'owner' }),
}));
vi.mock('@/db', () => ({
  getD1: () => ({
    prepare: (sql: string) => {
      if (mocks.failDatabase) throw new Error(mocks.secret);
      return {
        bind: () => ({
          first: async () =>
            sql.includes('FROM wallet_cleanups WHERE owner_id=? AND id=?')
              ? mocks.recoveryRow
              : sql.includes('workspace_wallets')
                ? { address: 'saved', revision: 1 }
                : null,
          run: async () => {
            if (mocks.recoveryRow) mocks.recoveryRow.state = 'finalized';
            return { meta: { changes: 1 } };
          },
        }),
      };
    },
  }),
}));
vi.mock('@/lib/wallet-cleanup', async (original) => ({
  ...(await original<typeof import('@/lib/wallet-cleanup')>()),
  inspectWalletCleanup: async () => ({}),
}));
vi.mock('@/lib/wallet-cleanup-server', async (original) => ({
  ...(await original<typeof import('@/lib/wallet-cleanup-server')>()),
  prepareWalletCleanup: mocks.prepareCleanup,
  prepareWalletCleanupBuy: mocks.prepareBuy,
  cleanupRpc: () => ({
    rpc: async (method: string) =>
      method === 'getGenesisHash'
        ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
        : {},
    source: 'synthetic',
  }),
  decodeWalletCleanupSellReceipt: async () => ({ deliveredLamports: '100' }),
}));
import { GET, POST } from './route';

const post = (body: object) =>
  POST(
    new Request('http://localhost/api/wallet-workspace/cleanup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
afterEach(() => {
  mocks.failDatabase = false;
  mocks.recoveryRow = null;
  mocks.prepareCleanup.mockReset();
  mocks.prepareBuy.mockReset();
  vi.restoreAllMocks();
});
it('returns fixed errors and fixed logs when storage throws a credential-like URL', async () => {
  mocks.failDatabase = true;
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const history = await GET(
    new Request('http://localhost/api/wallet-workspace/cleanup'),
  );
  const action = await post({
    action: 'recover',
    id: '11111111-1111-4111-8111-111111111111',
  });
  expect(history.status).toBe(503);
  expect(action.status).toBe(503);
  const text = JSON.stringify([
    await history.json(),
    await action.json(),
    log.mock.calls,
  ]);
  expect(text).not.toContain(mocks.secret);
  expect(log).toHaveBeenCalledWith('cleanup history unavailable');
  expect(log).toHaveBeenCalledWith('cleanup action failed', 'storage');
});
it('logs a fixed buy-preparation category without leaking the thrown message', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const wallet = bs58.encode(new Uint8Array(32).fill(7));
  const destination = bs58.encode(new Uint8Array(32).fill(8));
  mocks.recoveryRow = {
    id,
    batchId: id,
    wallet,
    walletRevision: 1,
    state: 'submitted',
    signature: 'synthetic',
    document: JSON.stringify({
      format: 'wallet-cleanup-sell-v1',
      id,
      wallet,
      walletRevision: 1,
      transaction: 'synthetic',
      destination,
      mint: destination,
    }),
    receipt: null,
    failure: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  mocks.prepareBuy.mockRejectedValue(new Error(mocks.secret));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await post({ action: 'recover', id });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(JSON.stringify([result, log.mock.calls])).not.toContain(mocks.secret);
  expect(mocks.prepareBuy).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith('cleanup buy preparation failed');
});
it('refuses to echo a provider error made entirely of formerly allowed characters', async () => {
  const secret = 'FAKE_TOKEN_SecretValue';
  mocks.prepareCleanup.mockRejectedValue(new Error(secret));
  const wallet = bs58.encode(new Uint8Array(32).fill(7));
  const destination = bs58.encode(new Uint8Array(32).fill(8));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await post({
    action: 'prepare',
    wallets: [{ address: wallet, revision: 1 }],
    destination,
  });
  expect(response.status).toBe(200);
  const result = (await response.json()) as { errors: { error: string }[] };
  expect(result.errors[0].error).toBe(
    'Cleanup checks unavailable for this wallet.',
  );
  expect(JSON.stringify([result, log.mock.calls])).not.toContain(secret);
  expect(mocks.prepareCleanup).toHaveBeenCalledOnce();
});
