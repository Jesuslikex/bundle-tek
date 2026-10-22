import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  chain,
  WALLET,
  MINT,
  supplySession,
} from '../../../../test/token-supply-fixture';
import {
  signSupplyAction,
  type TokenSupplyAction,
} from '@/lib/token-supply-action';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
import {
  solanaFamilyExclusionFixture,
  familyExclusionD1,
  exclusionOwner,
  reserveFamily,
  exclusionFamilies,
} from '../../../../test/solana-family-exclusion-fixture';

const mocks = vi.hoisted(() => ({
  db: null as unknown as D1Database,
  fetcher: null as unknown as typeof fetch,
  rpc: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => ({ userId: 'storage-owner' }),
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/token-supply-action-server', async (original) => {
  const actual =
    await original<typeof import('@/lib/token-supply-action-server')>();
  return {
    ...actual,
    prepareSupplyAction: (
      input: Parameters<typeof actual.prepareSupplyAction>[0],
      signal: AbortSignal,
    ) => actual.prepareSupplyAction(input, signal, mocks.fetcher),
    recheckSupplyAction: (
      review: Parameters<typeof actual.recheckSupplyAction>[0],
      signal: AbortSignal,
    ) => actual.recheckSupplyAction(review, signal, mocks.fetcher),
  };
});
vi.mock('@/lib/wallet-balances', async (original) => {
  const actual = await original<typeof import('@/lib/wallet-balances')>();
  return {
    ...actual,
    balanceRpc: (...args: Parameters<typeof actual.balanceRpc>) =>
      args[4] !== fetch ? actual.balanceRpc(...args) : mocks.rpc(...args),
  };
});
import { POST } from './route';

let sqlite: DatabaseSync;
let realFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  sqlite = solanaFamilyExclusionFixture();
  mocks.db = familyExclusionD1(sqlite);
  sqlite
    .prepare(`INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,label,role,updated_at)
    VALUES(?,'Solana',?,'','Synthetic','trading',?)`)
    .run(exclusionOwner, WALLET, new Date().toISOString());
  realFetch = vi.fn(async () => {
    throw Error('Real networking is forbidden in this test');
  });
  vi.stubGlobal('fetch', realFetch);
  mocks.rpc.mockReset();
});
afterEach(() => {
  sqlite.close();
  vi.unstubAllGlobals();
});

const prepare = () =>
  POST(
    new Request('https://bundle.test/api/wallet-workspace/supply-actions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://bundle.test',
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({
        action: 'prepare',
        kind: 'burn',
        wallet: WALLET,
        walletRevision: 1,
        mint: MINT,
        percent: '1',
        acknowledgeIrreversible: true,
      }),
    }),
  );

const action = (body: object) =>
  POST(
    new Request('https://bundle.test/api/wallet-workspace/supply-actions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://bundle.test',
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify(body),
    }),
  );

it('admits an unsigned review through the real decoder with controlled RPC on the full schema, without signing or sending', async () => {
  const fake = chain('burn');
  mocks.fetcher = fake.fetcher;
  const response = await prepare();
  expect(response.status).toBe(200);
  const body = (await response.json()) as { action: unknown };
  expect(body.action).toMatchObject({
    state: 'awaiting_signature',
    signature: null,
    wallet: WALLET,
  });
  expect(
    sqlite.prepare('SELECT state FROM token_supply_actions').get(),
  ).toEqual({ state: 'awaiting_signature' });
  expect(fake.calls).toContain('simulateTransaction');
  expect(fake.calls).not.toContain('sendTransaction');
  expect(realFetch).not.toHaveBeenCalled();
});

it.each(exclusionFamilies)(
  'refuses a %s hold that arrives after the HTTP preflight but before retention, with no partial supply row/event',
  async (family) => {
    const fake = chain('burn');
    let injected = false;
    mocks.fetcher = (async (url: string, init: RequestInit) => {
      const response = await fake.fetcher(url, init);
      if (
        JSON.parse(init.body as string).method === 'simulateTransaction' &&
        !injected
      ) {
        reserveFamily(sqlite, family, WALLET);
        injected = true;
      }
      return response;
    }) as typeof fetch;
    const response = await prepare();
    expect(injected).toBe(true);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('already reserved');
    const expected = family === 'supply' ? 1 : 0;
    expect(
      sqlite.prepare('SELECT count(*) n FROM token_supply_actions').get(),
    ).toEqual({ n: expected });
    expect(
      sqlite.prepare('SELECT count(*) n FROM token_supply_action_events').get(),
    ).toEqual({ n: expected });
    expect(fake.calls).not.toContain('sendTransaction');
    expect(realFetch).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  'legacy conflicting supply: migration applied=%s; unguarded control reaches only a fake send, guarded case retains and recovers',
  async (upgrade) => {
    // Deliberately retain the pre-0137 conflict. No production wallet/endpoint is used.
    sqlite.close();
    sqlite = solanaFamilyExclusionFixture(136);
    mocks.db = familyExclusionD1(sqlite);
    sqlite
      .prepare(`INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,label,role,updated_at)
    VALUES(?,'Solana',?,'','Synthetic','trading',?)`)
      .run(exclusionOwner, WALLET, new Date().toISOString());
    const fake = chain('burn');
    mocks.fetcher = fake.fetcher;
    const prepared = await prepare();
    expect(prepared.status).toBe(200);
    const saved = ((await prepared.json()) as { action: TokenSupplyAction })
      .action;
    expect(
      (await action({ action: 'begin_signing', id: saved.id })).status,
    ).toBe(200);
    // This is the published deterministic test seed, never a real vault/unlock.
    const signed = await signSupplyAction(
      supplySession,
      saved.document,
      () => {},
    );
    expect(
      (
        await action({
          action: 'register',
          id: saved.id,
          transaction: signed.transaction,
        })
      ).status,
    ).toBe(200);
    reserveFamily(sqlite, 'cleanup', WALLET);
    if (!upgrade) {
      mocks.rpc.mockImplementation(
        async (_endpoint: string, method: string) => {
          if (method === 'sendTransaction') return signed.signature;
          throw Error('Unexpected control RPC');
        },
      );
      const control = await action({
        action: 'submit',
        id: saved.id,
        transaction: signed.transaction,
      });
      expect(control.status).toBe(200);
      expect(mocks.rpc).toHaveBeenCalledTimes(1);
      expect(mocks.rpc.mock.calls[0][1]).toBe('sendTransaction');
      expect(realFetch).not.toHaveBeenCalled();
      return;
    }
    sqlite.exec(
      readFileSync('drizzle/0137_solana_wallet_family_exclusion.sql', 'utf8'),
    );
    const refused = await action({
      action: 'submit',
      id: saved.id,
      transaction: signed.transaction,
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain(
      'already reserved',
    );
    expect(
      sqlite.prepare('SELECT state,signature FROM token_supply_actions').get(),
    ).toEqual({ state: 'signed', signature: signed.signature });
    expect(mocks.rpc).not.toHaveBeenCalled();

    mocks.rpc.mockImplementation(async (_endpoint: string, method: string) => {
      if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
      if (method === 'getTransaction') return null;
      throw Error('No send or other RPC is allowed');
    });
    expect((await action({ action: 'recover', id: saved.id })).status).toBe(
      409,
    );
    expect(
      sqlite.prepare('SELECT state FROM token_supply_actions').get(),
    ).toEqual({ state: 'signed' });

    mocks.rpc.mockImplementation(async (_endpoint: string, method: string) => {
      if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
      if (method === 'getTransaction')
        return {
          transaction: [signed.transaction, 'base64'],
          slot: 150,
          blockTime: null,
          meta: {
            err: null,
            fee: 5000,
            preBalances: [1000000000, 0],
            postBalances: [999995000, 0],
            preTokenBalances: [
              {
                accountIndex: 1,
                mint: MINT,
                owner: WALLET,
                uiTokenAmount: { amount: '50000000000000' },
              },
            ],
            postTokenBalances: [
              {
                accountIndex: 1,
                mint: MINT,
                owner: WALLET,
                uiTokenAmount: { amount: '40000000000000' },
              },
            ],
          },
        };
      throw Error('No send or other RPC is allowed');
    });
    const recovered = await action({ action: 'recover', id: saved.id });
    expect(recovered.status).toBe(200);
    const result = (await recovered.json()) as { action: TokenSupplyAction };
    expect(result.action.state).toBe('finalized');
    expect(result.action.receipt?.supplyChangeRaw).toBe('-10000000000000');
    expect(sqlite.prepare('SELECT state FROM wallet_cleanups').get()).toEqual({
      state: 'awaiting_signature',
    });
    expect(
      mocks.rpc.mock.calls.every(
        ([_endpoint, method]) => method !== 'sendTransaction',
      ),
    ).toBe(true);
    expect(realFetch).not.toHaveBeenCalled();
  },
);
