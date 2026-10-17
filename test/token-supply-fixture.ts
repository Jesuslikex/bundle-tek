// Fake mainnet for burn/lock tests: holds balances and applies the action on simulate.
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { supplyActionInput } from '../lib/token-supply-action';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
import type { VaultSession } from '../lib/browser-wallet-vault';

export const seed = new Uint8Array(32).fill(5);
export const WALLET = bs58.encode(nacl.sign.keyPair.fromSeed(seed).publicKey);
export const MINT = bs58.encode(new Uint8Array(32).fill(9));
export const SUPPLY = 1_000_000_000_000_000n;
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

export function mintBytes(supply: bigint) {
  const b = new Uint8Array(82),
    v = new DataView(b.buffer);
  v.setBigUint64(36, supply, true);
  b[44] = 6;
  b[45] = 1;
  return b;
}
export function tokenBytes(amount: bigint, owner = WALLET) {
  const b = new Uint8Array(165),
    v = new DataView(b.buffer);
  b.set(bs58.decode(MINT), 0);
  b.set(bs58.decode(owner), 32);
  v.setBigUint64(64, amount, true);
  b[108] = 1;
  return b;
}
export const token = (data: Uint8Array) => ({
  owner: TOKEN_PROGRAM_ADDRESS,
  executable: false,
  lamports: 2039280,
  data: [b64(data), 'base64'],
});

/** Minimal mainnet stand-in: holds balances and applies the action on simulate. */
export function chain(
  kind: 'burn' | 'lock',
  options: { tokenFeeBps?: bigint } = {},
) {
  const state = {
    lamports: 1_000_000_000n,
    balance: 50_000_000_000_000n, // 5% of supply
    supply: SUPPLY,
    simulateErr: null as unknown,
    extraLamports: 0n,
  };
  const calls: string[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(init.body as string);
    calls.push(method);
    const context = { slot: 100 };
    let result: unknown;
    const wallet = {
      owner: '11111111111111111111111111111111',
      executable: false,
      lamports: Number(state.lamports),
      data: ['', 'base64'],
    };
    switch (method) {
      case 'getGenesisHash':
        result = SOLANA_MAINNET_GENESIS;
        break;
      case 'getAccountInfo':
        result = {
          context,
          value: { ...token(mintBytes(state.supply)) },
        };
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
      case 'getMultipleAccounts':
        result = {
          context,
          value: (params[0] as string[]).map((_k, i) =>
            i === 0
              ? wallet
              : i === 1
                ? token(mintBytes(state.supply))
                : i === 2
                  ? token(tokenBytes(state.balance))
                  : null,
          ),
        };
        break;
      case 'getFeeForMessage':
        result = { context, value: kind === 'lock' ? 10000 : 5000 };
        break;
      case 'getMinimumBalanceForRentExemption':
        result = 890880;
        break;
      case 'simulateTransaction': {
        const amount = (state.supply * 10_000n) / 1_000_000n; // 1%
        const debit =
          kind === 'lock'
            ? amount + (amount * (options.tokenFeeBps ?? 0n)) / 10_000n
            : amount;
        const sol =
          (kind === 'lock' ? 10000n + 3_000_000n : 5000n) + state.extraLamports;
        result = {
          context,
          value: {
            err: state.simulateErr,
            accounts: [
              { ...wallet, lamports: Number(state.lamports - sol) },
              token(tokenBytes(state.balance - debit)),
              token(
                mintBytes(
                  kind === 'burn' ? state.supply - amount : state.supply,
                ),
              ),
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
export const input = (kind: 'burn' | 'lock', lockMetadata?: string) =>
  supplyActionInput({
    kind,
    wallet: WALLET,
    walletRevision: 1,
    mint: MINT,
    percent: '1',
    ...(kind === 'lock' ? { durationSeconds: 86400, lockMetadata } : {}),
    acknowledgeIrreversible: true,
  });
export const signal = () => AbortSignal.timeout(10_000);

export const supplySession = {
  payload: {
    version: 1,
    wallets: [
      {
        family: 'solana',
        address: WALLET,
        seed: Array.from(seed, (x) => x.toString(16).padStart(2, '0')).join(''),
      },
    ],
  },
} as unknown as VaultSession;
