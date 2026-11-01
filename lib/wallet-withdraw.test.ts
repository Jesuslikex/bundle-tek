import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./browser-wallet-vault', () => ({
  VAULT_STORAGE_KEY: 'vault',
  unlockVault: vi.fn(async () => ({ payload: { wallets: [{ seed: 'x' }] } })),
}));
vi.mock('./wallet-cleanup', () => ({
  signWalletCleanupBatch: vi.fn(async () => [{ id: 'c1', transaction: 'tx1' }]),
  validatedWalletCleanup: vi.fn(async (row: unknown) => row),
}));

import { unlockVault } from './browser-wallet-vault';
import { signWalletCleanupBatch } from './wallet-cleanup';
import { WalletWithdrawError, withdrawWalletTo } from './wallet-withdraw';

const WALLET = {
  walletAddresses: ['seller'],
  destination: 'buyer',
  password: 'pw',
};

type Call = { action: string; [key: string]: unknown };

let calls: Call[];

function respond(body: Call) {
  calls.push(body);
  switch (body.action) {
    case 'run':
      return {
        ok: true,
        json: async () => ({
          batchId: 'b1',
          cleanups: [{ id: 'c1', state: 'awaiting_signature' }],
        }),
      };
    case 'begin_signing':
      return {
        ok: true,
        json: async () => ({
          cleanups: [{ id: 'c1', state: 'signing', document: { d: 1 } }],
        }),
      };
    case 'reject_signing':
      return { ok: true, json: async () => ({}) };
    default:
      return { ok: true, json: async () => ({}) };
  }
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) =>
      respond(JSON.parse(init.body) as Call),
    ),
  );
  vi.stubGlobal('localStorage', { getItem: () => 'vault-blob' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const actions = () => calls.map((call) => call.action);

describe('withdrawWalletTo', () => {
  it('runs, signs and submits in order', async () => {
    const result = await withdrawWalletTo(WALLET);
    expect(actions()).toEqual(['run', 'begin_signing', 'register', 'submit']);
    expect(result).toEqual({ batchId: 'b1', submitted: 1, failures: [] });
  });

  it('sends the wallet as input and the destination as output', async () => {
    await withdrawWalletTo(WALLET);
    expect(calls[0]).toMatchObject({
      input_wallet_pubkeys: ['seller'],
      output_wallet_pubkeys: ['buyer'],
    });
  });

  it('needs a password', async () => {
    await expect(
      withdrawWalletTo({ ...WALLET, password: '' }),
    ).rejects.toBeInstanceOf(WalletWithdrawError);
    expect(actions()).toEqual([]);
  });

  it('refuses an unchanged destination', async () => {
    await expect(
      withdrawWalletTo({ ...WALLET, destination: 'seller' }),
    ).rejects.toThrow(/must differ/);
  });

  it('refuses when the wallet has nothing to sweep', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ batchId: 'b1', cleanups: [] }),
      })),
    );
    await expect(withdrawWalletTo(WALLET)).rejects.toThrow(
      /Nothing to withdraw/,
    );
  });

  it('reports the server message on a failed run', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'Batch busy.' }),
      })),
    );
    await expect(withdrawWalletTo(WALLET)).rejects.toThrow('Batch busy.');
  });

  it('releases claimed rows when signing fails before any signature', async () => {
    vi.mocked(signWalletCleanupBatch).mockRejectedValueOnce(
      new Error('vault locked'),
    );
    await expect(withdrawWalletTo(WALLET)).rejects.toThrow('vault locked');
    expect(actions()).toContain('reject_signing');
    expect(actions()).not.toContain('register');
  });

  it('does not release rows when a signature already exists', async () => {
    // register fails, but the signature counts, so nothing is rejected.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as Call;
        if (body.action === 'register')
          return { ok: false, json: async () => ({ error: 'Submit failed.' }) };
        return respond(body);
      }),
    );
    await expect(withdrawWalletTo(WALLET)).rejects.toThrow(/Submit failed/);
    expect(actions()).not.toContain('reject_signing');
  });

  it('wipes the unlocked session', async () => {
    const session = { payload: { wallets: [{ seed: 'x' }] } };
    vi.mocked(unlockVault).mockResolvedValueOnce(session as never);
    await withdrawWalletTo(WALLET);
    expect(session.payload.wallets).toEqual([]);
  });

  it('reports progress steps', async () => {
    const steps: string[] = [];
    await withdrawWalletTo({ ...WALLET, onStep: (step) => steps.push(step) });
    expect(steps).toEqual(['preparing', 'signing', 'submitting']);
  });

  it('sends every wallet as input with the single destination', async () => {
    await withdrawWalletTo({ ...WALLET, walletAddresses: ['a', 'b', 'c'] });
    expect(calls[0]).toMatchObject({
      input_wallet_pubkeys: ['a', 'b', 'c'],
      output_wallet_pubkeys: ['buyer'],
    });
  });

  it('needs at least one wallet', async () => {
    await expect(
      withdrawWalletTo({ ...WALLET, walletAddresses: [] }),
    ).rejects.toThrow(/at least one wallet/);
    expect(actions()).toEqual([]);
  });

  it('refuses a destination that is one of the wallets', async () => {
    await expect(
      withdrawWalletTo({ ...WALLET, walletAddresses: ['a', 'buyer'] }),
    ).rejects.toThrow(/must differ/);
  });
});
