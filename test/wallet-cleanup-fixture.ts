import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { vi } from 'vitest';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
import {
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  WRAPPED_SOL_MINT,
  type WalletCleanupReview,
} from '../lib/wallet-cleanup';
import type { VaultSession } from '../lib/browser-wallet-vault';

const fill = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
export const cleanupKeys = (n: number) => {
  const seed = new Uint8Array(32).fill(n),
    pair = nacl.sign.keyPair.fromSeed(seed);
  pair.secretKey.fill(0);
  return {
    address: bs58.encode(pair.publicKey),
    seed: Array.from(seed, (b) => b.toString(16).padStart(2, '0')).join(''),
  };
};

/** Synthetic SPL token account bytes (165 base bytes, optional Token-2022 TLVs). */
export function tokenAccountData(input: {
  mint: string;
  owner: string;
  amount?: bigint;
  state?: number;
  native?: bigint;
  closeAuthority?: string;
  extensions?: { type: number; data: Uint8Array }[];
}) {
  const ext = input.extensions ?? [];
  const size = ext.length
    ? 166 + ext.reduce((n, e) => n + 4 + e.data.length, 0)
    : 165;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes.set(bs58.decode(input.mint), 0);
  bytes.set(bs58.decode(input.owner), 32);
  view.setBigUint64(64, input.amount ?? 0n, true);
  bytes[108] = input.state ?? 1;
  if (input.native !== undefined) {
    view.setUint32(109, 1, true);
    view.setBigUint64(113, input.native, true);
  }
  if (input.closeAuthority) {
    view.setUint32(129, 1, true);
    bytes.set(bs58.decode(input.closeAuthority), 133);
  }
  if (ext.length) {
    bytes[165] = 2;
    let offset = 166;
    for (const e of ext) {
      view.setUint16(offset, e.type, true);
      view.setUint16(offset + 2, e.data.length, true);
      bytes.set(e.data, offset + 4);
      offset += 4 + e.data.length;
    }
  }
  return btoa(String.fromCharCode(...bytes));
}
/** Synthetic initialized SPL mint with the given decimals. */
export function mintData(decimals: number) {
  const bytes = new Uint8Array(82);
  bytes[44] = decimals;
  bytes[45] = 1;
  return btoa(String.fromCharCode(...bytes));
}
/** Minimal canonical unsigned v0 packet signed by `wallet` (sell stand-in). */
export async function v0Packet(wallet: string, salt = 1) {
  const program = fill(200 + salt);
  const message = [
    0x80,
    1,
    0,
    1,
    2,
    ...bs58.decode(wallet),
    ...bs58.decode(program),
    ...bs58.decode(fill(3)),
    1,
    1,
    1,
    0,
    1,
    salt,
    0,
  ];
  const bytes = Uint8Array.from([1, ...new Uint8Array(64), ...message]);
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer);
  return {
    transaction: btoa(String.fromCharCode(...bytes)),
    sha256: Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join(''),
  };
}
const u64 = (value: bigint) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
};

export function cleanupFixture(n = 7) {
  const owner = cleanupKeys(n),
    wallet = owner.address,
    destination = cleanupKeys(n + 1).address,
    blockhash = fill(3),
    mintA = fill(11),
    mintB = fill(12);
  const tokenAccount = (lamports: string, data: string, program: string) => ({
    lamports,
    owner: program,
    executable: false,
    data: [data, 'base64'],
  });
  const legacy = [
    {
      pubkey: fill(40 + n),
      account: tokenAccount(
        '2039280',
        tokenAccountData({ mint: mintA, owner: wallet }),
        TOKEN_PROGRAM,
      ),
    },
    {
      pubkey: fill(50 + n),
      account: tokenAccount(
        '3039280',
        tokenAccountData({
          mint: WRAPPED_SOL_MINT,
          owner: wallet,
          amount: 1_000_000n,
          native: 2_039_280n,
        }),
        TOKEN_PROGRAM,
      ),
    },
    {
      pubkey: fill(60 + n),
      account: tokenAccount(
        '2039280',
        tokenAccountData({ mint: mintB, owner: wallet, amount: 5n }),
        TOKEN_PROGRAM,
      ),
    },
    {
      pubkey: fill(70 + n),
      account: tokenAccount(
        '2039280',
        tokenAccountData({ mint: mintB, owner: wallet, state: 2 }),
        TOKEN_PROGRAM,
      ),
    },
  ];
  const t22 = [
    {
      pubkey: fill(80 + n),
      account: tokenAccount(
        '2074080',
        tokenAccountData({
          mint: mintA,
          owner: wallet,
          extensions: [{ type: 7, data: new Uint8Array() }],
        }),
        TOKEN_2022_PROGRAM,
      ),
    },
    {
      pubkey: fill(90 + n),
      account: tokenAccount(
        '2157600',
        tokenAccountData({
          mint: mintB,
          owner: wallet,
          extensions: [
            { type: 7, data: new Uint8Array() },
            { type: 2, data: u64(3n) },
          ],
        }),
        TOKEN_2022_PROGRAM,
      ),
    },
  ];
  const state = {
    walletLamports: 20_000_000n,
    destinationLamports: 1_000_000_000n,
    keepLamports: 0n,
    feeLamports: 5000n,
    simulationErr: null as unknown,
    simulationDrift: 0n,
    blockhashValid: true,
    receiptErr: null as unknown,
    receiptDrift: 0n,
    signedTransaction: '',
    contextSlot: 100,
  };
  const reclaim = 2_039_280n + 3_039_280n + 2_074_080n;
  const system = (lamports: bigint) =>
    lamports === 0n
      ? null
      : {
          lamports: lamports.toString(),
          owner: SYSTEM_PROGRAM,
          executable: false,
          data: ['', 'base64'],
        };
  const sweep = () =>
    state.walletLamports - state.feeLamports - state.keepLamports;
  const calls: string[] = [];
  const result = (method: string, params: unknown[]) => {
    const context = { slot: state.contextSlot };
    switch (method) {
      case 'getGenesisHash':
        return SOLANA_MAINNET_GENESIS;
      case 'getLatestBlockhash':
        return { context, value: { blockhash, lastValidBlockHeight: 200 } };
      case 'getTokenAccountsByOwner': {
        const program = (params[1] as { programId: string }).programId;
        return { context, value: program === TOKEN_PROGRAM ? legacy : t22 };
      }
      case 'getMultipleAccounts':
        if ((params[0] as string[])[0] === mintB)
          return {
            context,
            value: (params[0] as string[]).map(() => ({
              lamports: '1461600',
              owner: TOKEN_PROGRAM,
              executable: false,
              data: [mintData(6), 'base64'],
            })),
          };
        return {
          context,
          value: [
            system(state.walletLamports),
            system(state.destinationLamports),
          ],
        };
      case 'getFeeForMessage':
        return { context, value: Number(state.feeLamports) };
      case 'simulateTransaction': {
        const addresses =
          (params[1] as { accounts?: { addresses: string[] } }).accounts
            ?.addresses ?? [];
        return {
          context,
          value: {
            err: state.simulationErr,
            accounts: addresses.map((a, i) =>
              i === 0
                ? system(state.keepLamports)
                : i === 1
                  ? system(
                      state.destinationLamports +
                        reclaim +
                        sweep() +
                        state.simulationDrift,
                    )
                  : null,
            ),
          },
        };
      }
      case 'isBlockhashValid':
        return { context, value: state.blockhashValid };
      case 'getBlockHeight':
        return 150;
      default:
        throw new Error('Unexpected fixture method ' + method);
    }
  };
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string);
    calls.push(body.method);
    return Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: result(body.method, body.params),
    });
  }) as unknown as typeof fetch;
  const session = async (...wallets: { address: string; seed: string }[]) =>
    ({
      key: await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      ),
      salt: 'fixture',
      payload: {
        version: 1,
        wallets: wallets.map((w) => ({
          id: crypto.randomUUID(),
          family: 'solana' as const,
          address: w.address,
          seed: w.seed,
          createdAt: new Date().toISOString(),
        })),
      },
    }) satisfies VaultSession;
  /** Finalized legacy receipt for the exact signed packet. */
  const receipt = (review: WalletCleanupReview, transaction: string) => {
    const programs = new Set(review.close.map((c) => c.program)).size + 1;
    const pre = [
      state.walletLamports,
      state.destinationLamports,
      ...review.close.map((c) => BigInt(c.lamports)),
      ...Array(programs).fill(1n),
    ];
    const failed = state.receiptErr !== null;
    const post = failed
      ? [pre[0] - state.feeLamports, ...pre.slice(1)]
      : [
          BigInt(review.keepLamports),
          pre[1] +
            BigInt(review.reclaimLamports) +
            BigInt(review.sweepLamports) +
            state.receiptDrift,
          ...review.close.map(() => 0n),
          ...Array(programs).fill(1n),
        ];
    return {
      slot: '120',
      blockTime: '1792400000',
      version: 'legacy',
      transaction: [transaction, 'base64'],
      meta: {
        err: state.receiptErr,
        fee: state.feeLamports.toString(),
        preBalances: pre.map(String),
        postBalances: post.map(String),
      },
    };
  };
  /** Fake Jupiter order + simulation for the holding of mintB (5 raw, 6 decimals). */
  const sell = {
    simulation: {
      succeeded: true,
      status: 'Matched fields',
      source: fill(60 + n),
      inputAmountMatches: true as boolean | null,
      nativeChangeRaw: '995000' as string | null,
    },
    deps: {
      prepare: (async (input: { wallet: string; amount: string }) => {
        const packet = await v0Packet(input.wallet);
        return {
          executionAllowed: false,
          side: 'Sell',
          inputMint: mintB,
          outputMint: WRAPPED_SOL_MINT,
          inAmount: (BigInt(input.amount.replace('.', '')) || 0n).toString(),
          outAmount: '1000000',
          minimumOutAmount: '995000',
          slippageBps: 50,
          router: 'metis',
          priceImpactPct: '0.1',
          source: 'api.jup.ag',
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30000).toISOString(),
          preparation: {
            ...packet,
            lastValidBlockHeight: '200',
            estimatedFeesLamports: '5000',
          },
        };
      }) as never,
      simulate: (async () => ({
        succeeded: sell.simulation.succeeded,
        routeAssessment: {
          status: sell.simulation.status,
          decoded: { sourceAccount: sell.simulation.source },
        },
        inputAmountMatches: sell.simulation.inputAmountMatches,
        nativeChangeRaw: sell.simulation.nativeChangeRaw,
        networkFeeLamports: '5000',
        simulationSlot: 100,
        source: 'rpc.test',
      })) as never,
    },
    mint: mintB,
    /** Finalized v0 receipt selling the whole holding. */
    receipt: (transaction: string, soldRaw = 5n, err: unknown = null) => ({
      slot: '130',
      blockTime: null,
      version: 0,
      transaction: [transaction, 'base64'],
      meta: {
        err,
        fee: '5000',
        preBalances: ['20000000', '1'],
        postBalances: ['20990000', '1'],
        preTokenBalances: [
          { mint: mintB, owner: wallet, uiTokenAmount: { amount: '5' } },
        ],
        postTokenBalances: [
          {
            mint: mintB,
            owner: wallet,
            uiTokenAmount: { amount: (5n - soldRaw).toString() },
          },
        ],
      },
    }),
  };
  return {
    sell,
    owner,
    wallet,
    destination,
    blockhash,
    state,
    calls,
    reclaim,
    sweep,
    fetcher,
    session,
    receipt,
  };
}
