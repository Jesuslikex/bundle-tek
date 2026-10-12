import { it, expect, vi, afterEach } from 'vitest';
import bs58 from 'bs58';
import { observeImportedSwapBalance } from './imported-swap-balance';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { TOKEN_PROGRAMS } from './wallet-holdings';
vi.mock('./solana-rpc', () => ({
  getSolanaIndexerRpcEndpoint: () => 'https://mainnet.helius-rpc.com/',
}));
afterEach(() => vi.unstubAllGlobals());
const wallet = bs58.encode(new Uint8Array(32).fill(1)),
  mint = bs58.encode(new Uint8Array(32).fill(2));
function provider({
  token2022 = false,
  empty = false,
  wrongProgram = false,
  nativeSlot = 104,
  extensions = ['metadataPointer'],
}: {
  token2022?: boolean;
  empty?: boolean;
  wrongProgram?: boolean;
  nativeSlot?: number;
  extensions?: string[];
} = {}) {
  const program = TOKEN_PROGRAMS[token2022 ? 1 : 0],
    calls: Array<{ method: string; params: unknown[] }> = [];
  let mintReads = 0;
  vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push(body);
    let result: unknown;
    if (body.method === 'getGenesisHash') result = SOLANA_MAINNET_GENESIS;
    else if (body.method === 'getAccountInfo') {
      expect(body.params[0]).toBe(mint);
      result = {
        context: { slot: mintReads++ ? 103 : 100 },
        value: {
          owner: wrongProgram ? TOKEN_PROGRAMS[1] : program,
          executable: false,
          data: {
            space: token2022 ? 250 : 82,
            parsed: {
              type: 'mint',
              info: {
                isInitialized: true,
                decimals: 6,
                ...(token2022
                  ? {
                      extensions: extensions.map((extension) => ({
                        extension,
                      })),
                    }
                  : {}),
              },
            },
          },
        },
      };
    } else if (body.method === 'getTokenAccountsByOwnerV2') {
      expect(body.params[0]).toBe(wallet);
      expect(body.params[1]).toEqual({ mint });
      result = {
        context: { slot: 101 },
        value: {
          paginationKey: null,
          accounts: empty
            ? []
            : [0, 1].map((i) => ({
                pubkey: bs58.encode(new Uint8Array(32).fill(10 + i)),
                account: {
                  owner: program,
                  executable: false,
                  data: {
                    space: token2022 ? 180 : 165,
                    parsed: {
                      type: 'account',
                      info: {
                        mint,
                        owner: wallet,
                        state: i ? 'initialized' : 'frozen',
                        tokenAmount: {
                          amount: i ? '3003' : '1000',
                          decimals: 6,
                        },
                        ...(token2022
                          ? { extensions: [{ extension: 'immutableOwner' }] }
                          : {}),
                      },
                    },
                  },
                },
              })),
        },
      };
    } else if (body.method === 'getBalance')
      result = { context: { slot: nativeSlot }, value: 10000000 };
    else throw new Error('Full portfolio or unrelated RPC blocked.');
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  });
  return {
    calls,
    token: {
      chain: 'Solana' as const,
      address: mint,
      decimals: 6,
      tokenProgram: program,
    },
  };
}
it.each(['Buy', 'Sell'] as const)(
  'reads only trade mint and native SOL for %s',
  async (side) => {
    const { calls, token } = provider();
    const balance = await observeImportedSwapBalance(
      token,
      wallet,
      side,
      side === 'Buy' ? '0.01' : '0.001501',
      AbortSignal.timeout(1000),
    );
    expect(balance).toMatchObject({
      inventoryScope: 'mint',
      tokenRaw: '4003',
      frozenRaw: '1000',
      unfrozenRaw: '3003',
      amountCovered: true,
      preparationSupported: true,
      nativeRaw: '10000000',
      nativeSlot: 104,
      executionAllowed: false,
    });
    expect(calls.map((c) => c.method)).toEqual([
      'getGenesisHash',
      'getAccountInfo',
      'getTokenAccountsByOwnerV2',
      'getBalance',
    ]);
    expect(calls[3].params).toEqual([
      wallet,
      { commitment: 'confirmed', minContextSlot: 101 },
    ]);
  },
);
it('buys against an empty mint inventory and rejects a foreign mint program even when empty', async () => {
  let { token } = provider({ empty: true });
  expect(
    (
      await observeImportedSwapBalance(
        token,
        wallet,
        'Buy',
        '0.01',
        AbortSignal.timeout(1000),
      )
    ).tokenRaw,
  ).toBe('0');
  ({ token } = provider({ empty: true, wrongProgram: true }));
  await expect(
    observeImportedSwapBalance(
      token,
      wallet,
      'Buy',
      '0.01',
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow('Holding identity');
});
it('excludes frozen units and rejects native context preceding mint inventory', async () => {
  let { token } = provider();
  expect(
    await observeImportedSwapBalance(
      token,
      wallet,
      'Sell',
      '0.004',
      AbortSignal.timeout(1000),
    ),
  ).toMatchObject({ amountCovered: false, shortfallRaw: '997' });
  ({ token } = provider({ nativeSlot: 100 }));
  await expect(
    observeImportedSwapBalance(
      token,
      wallet,
      'Sell',
      '0.001',
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow('changed or expired');
});
it('rechecks Token-2022 mint extensions after mint account inventory', async () => {
  const initial = provider({ token2022: true }),
    calls = initial.calls;
  let token = initial.token;
  expect(
    await observeImportedSwapBalance(
      token,
      wallet,
      'Sell',
      '0.001501',
      AbortSignal.timeout(1000),
    ),
  ).toMatchObject({
    preparationSupported: true,
    mintSlot: 103,
    blockedExtensions: [],
  });
  expect(calls[3].method).toBe('getAccountInfo');
  expect(calls[4].params).toEqual([
    wallet,
    { commitment: 'confirmed', minContextSlot: 103 },
  ]);
  ({ token } = provider({
    token2022: true,
    extensions: ['transferFeeConfig'],
  }));
  expect(
    await observeImportedSwapBalance(
      token,
      wallet,
      'Sell',
      '0.001501',
      AbortSignal.timeout(1000),
    ),
  ).toMatchObject({
    preparationSupported: false,
    blockedExtensions: ['mint: transferFeeConfig'],
  });
});
