// Fake mainnet for Streamflow airdrop tests: holds balances and applies the reviewed step on simulate.
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { AIRDROP_PROGRAM } from '../lib/token-airdrop';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
import type { VaultSession } from '../lib/browser-wallet-vault';
import {
  MINT,
  mintBytes,
  SUPPLY,
  token,
  tokenBytes,
} from './token-supply-fixture';

export { MINT };
const seeds = [5, 6, 7, 8].map((n) => new Uint8Array(32).fill(n));
const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const [CREATOR, OUT1, OUT2, OUT3] = seeds.map((s) =>
  bs58.encode(nacl.sign.keyPair.fromSeed(s).publicKey),
);
export const airdropSession = {
  payload: {
    version: 1,
    wallets: seeds.map((s) => ({
      family: 'solana',
      address: bs58.encode(nacl.sign.keyPair.fromSeed(s).publicKey),
      seed: hex(s),
    })),
  },
} as unknown as VaultSession;
const find = (bytes: Uint8Array, needle: number[]) => {
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++)
      if (bytes[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
};
const u64 = (bytes: Uint8Array, at: number) =>
  new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(at, true);

export function airdropChain() {
  const state = {
    lamports: 1_000_000_000n,
    /** Token balance per wallet; a missing entry means no token account yet. */
    balances: { [CREATOR]: 1_000_000_000n } as Record<string, bigint>,
    created: false,
    vault: 0n,
    claimed: [] as string[],
    simulateErr: null as unknown,
    claimFeeLamports: 0n,
    extraLamports: 0n,
    transferFee: false,
  };
  const calls: string[] = [];
  const mintAccount = () => {
    if (!state.transferFee) return token(mintBytes(SUPPLY));
    // Token-2022 mint with an (empty) TransferFeeConfig extension.
    const b = new Uint8Array(166 + 4 + 108);
    b.set(mintBytes(SUPPLY));
    b[165] = 1;
    b[166] = 1;
    b[168] = 108;
    return {
      ...token(b),
      owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    };
  };
  const walletAccount = (extra = 0n) => ({
    owner: '11111111111111111111111111111111',
    executable: false,
    lamports: Number(state.lamports - extra),
    data: ['', 'base64'],
  });
  const own = (wallet: string, change = 0n) =>
    state.balances[wallet] === undefined && change === 0n
      ? null
      : token(tokenBytes((state.balances[wallet] ?? 0n) + change, wallet));
  const fetcher = (async (_url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(init.body as string);
    calls.push(method);
    const context = { slot: 100 };
    let result: unknown;
    switch (method) {
      case 'getGenesisHash':
        result = SOLANA_MAINNET_GENESIS;
        break;
      case 'getAccountInfo':
        result = { context, value: mintAccount() };
        break;
      case 'getLatestBlockhash':
        result = {
          context,
          value: {
            blockhash: bs58.encode(new Uint8Array(32).fill(4)),
            lastValidBlockHeight: 2000,
          },
        };
        break;
      case 'getMultipleAccounts': {
        // [wallet, mint, own token account, distributor, vault, claim status?]
        const keys = params[0] as string[];
        result = {
          context,
          value: keys.map((k, i) =>
            i === 0
              ? walletAccount()
              : i === 1
                ? mintAccount()
                : i === 2
                  ? own(keys[0])
                  : i === 3
                    ? state.created
                      ? {
                          owner: AIRDROP_PROGRAM,
                          executable: false,
                          lamports: 3_000_000,
                          data: ['AA==', 'base64'],
                        }
                      : null
                    : i === 4
                      ? state.created
                        ? token(tokenBytes(state.vault, keys[3]))
                        : null
                      : state.claimed.includes(keys[0])
                        ? {
                            owner: AIRDROP_PROGRAM,
                            executable: false,
                            lamports: 1_000_000,
                            data: ['AA==', 'base64'],
                          }
                        : null,
          ),
        };
        break;
      }
      case 'getFeeForMessage':
        result = { context, value: 5000 };
        break;
      case 'getMinimumBalanceForRentExemption':
        result = 890880;
        break;
      case 'simulateTransaction': {
        const bytes = Uint8Array.from(atob(params[0] as string), (c) =>
            c.charCodeAt(0),
          ),
          payer = bs58.encode(bytes.slice(69, 101));
        const create = find(bytes, [32, 139, 112, 171, 0, 2, 225, 155]),
          claim = find(bytes, [78, 177, 98, 123, 210, 21, 187, 83]);
        const change =
          create >= 0
            ? -u64(bytes, create + 48)
            : claim >= 0
              ? u64(bytes, claim + 8)
              : state.vault;
        const sol =
          5000n +
          (create >= 0
            ? 6_000_000n
            : claim >= 0
              ? state.claimFeeLamports
              : 0n) +
          state.extraLamports;
        result = {
          context,
          value: {
            err: state.simulateErr,
            accounts: [
              walletAccount(sol),
              own(payer, change) ?? own(payer, 0n),
            ],
          },
        };
        break;
      }
      case 'isBlockhashValid':
        result = { context, value: true };
        break;
      default:
        throw new Error('unexpected ' + method);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  }) as unknown as typeof fetch;
  return { state, calls, fetcher };
}
export const signal = () => AbortSignal.timeout(10_000);
