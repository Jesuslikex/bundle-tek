import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { vi } from 'vitest';
import { prepareNativeWithdrawal } from '../lib/native-withdrawal-server';
import {
  withdrawalInput,
  signNativeWithdrawal,
} from '../lib/native-withdrawal';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
import type { VaultSession } from '../lib/browser-wallet-vault';
export async function nativeWithdrawalFixture() {
  const seed = new Uint8Array(32).fill(7),
    pair = nacl.sign.keyPair.fromSeed(seed),
    wallet = bs58.encode(pair.publicKey),
    recipient = bs58.encode(new Uint8Array(32).fill(2)),
    blockhash = bs58.encode(new Uint8Array(32).fill(3));
  pair.secretKey.fill(0);
  const account = (lamports: string) => ({
    lamports,
    owner: '11111111111111111111111111111111',
    executable: false,
    data: ['', 'base64'],
  });
  const data: Record<string, unknown> = {
    getGenesisHash: SOLANA_MAINNET_GENESIS,
    getLatestBlockhash: {
      context: { slot: 100 },
      value: { blockhash, lastValidBlockHeight: 200 },
    },
    getAccountInfo: { context: { slot: 100 }, value: account('20000000') },
    getMinimumBalanceForRentExemption: 890880,
    getFeeForMessage: { context: { slot: 100 }, value: 5000 },
    simulateTransaction: { context: { slot: 100 }, value: { err: null } },
    isBlockhashValid: { context: { slot: 100 }, value: true },
    getBlockHeight: 150,
  };
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (typeof init?.body !== 'string')
      throw new Error('Expected fixture JSON request.');
    const body = JSON.parse(init.body);
    const result =
      body.method === 'getMultipleAccounts'
        ? {
            context: { slot: 100 },
            value:
              body.params[0].length === 1
                ? [null]
                : [account('20000000'), null],
          }
        : data[body.method];
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  }) as unknown as typeof fetch;
  const review = await prepareNativeWithdrawal(
    withdrawalInput(wallet, recipient, '0.01', 1),
    AbortSignal.timeout(10000),
    fetcher,
  );
  const session = {
    key: await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    ),
    salt: 'fixture',
    payload: {
      version: 1,
      wallets: [
        {
          id: crypto.randomUUID(),
          family: 'solana',
          address: wallet,
          seed: Array.from(seed, (b) => b.toString(16).padStart(2, '0')).join(
            '',
          ),
          createdAt: new Date().toISOString(),
        },
      ],
    },
  } satisfies VaultSession;
  const signed = await signNativeWithdrawal(session, review, () => {});
  const receipt = {
    slot: '120',
    blockTime: null,
    version: 'legacy' as const,
    transaction: [signed.transaction, 'base64'],
    meta: {
      err: null,
      fee: '5000',
      preBalances: ['20000000', '0', '1'],
      postBalances: ['9995000', '10000000', '1'],
    },
  };
  return { review, signed, receipt, fetcher, data, wallet, recipient, session };
}
