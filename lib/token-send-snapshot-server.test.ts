import { expect, it } from 'vitest';
import bs58 from 'bs58';
import { tokenSendSnapshot } from './token-send-snapshot-server';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  MINT,
  mintBytes,
  SUPPLY,
  token,
  tokenBytes,
  WALLET,
} from '../test/token-supply-fixture';

const OTHER = bs58.encode(new Uint8Array(32).fill(12));

it('reads supply and every source balance from one finalized snapshot', async () => {
  const methods: string[] = [];
  const fetcher = (async (_u: string, init: RequestInit) => {
    const { method, params } = JSON.parse(init.body as string);
    methods.push(method);
    const result =
      method === 'getGenesisHash'
        ? SOLANA_MAINNET_GENESIS
        : method === 'getAccountInfo'
          ? { context: { slot: 5 }, value: token(mintBytes(SUPPLY)) }
          : {
              context: { slot: 6 },
              value: [
                token(mintBytes(SUPPLY)),
                token(tokenBytes(42n, WALLET)),
                null,
              ].slice(0, (params[0] as string[]).length),
            };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  }) as unknown as typeof fetch;
  const snapshot = await tokenSendSnapshot(
    MINT,
    [WALLET, OTHER],
    AbortSignal.timeout(5000),
    fetcher,
  );
  expect(snapshot).toMatchObject({
    supplyRaw: SUPPLY.toString(),
    decimals: 6,
    slot: 6,
    balances: [
      { address: WALLET, raw: '42' },
      { address: OTHER, raw: '0' },
    ],
  });
  expect(methods).toEqual([
    'getGenesisHash',
    'getAccountInfo',
    'getMultipleAccounts',
  ]);
  await expect(
    tokenSendSnapshot(MINT, [], AbortSignal.timeout(5000), fetcher),
  ).rejects.toThrow(/source wallets/);
});
