import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
import {
  creatorFeeAddresses,
  creatorFeeQuoteAddresses,
  CLAIM_SYSTEM,
  CLAIM_TOKEN,
  CLAIM_WSOL,
} from '@/lib/pump-creator-fees';

export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const BLOCKHASH = bs58.encode(new Uint8Array(32).fill(9));
type Account = { lamports: bigint; owner: string; data: Uint8Array };
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
export const mintData = (decimals: number) => {
  const d = new Uint8Array(82);
  d[44] = decimals;
  d[45] = 1;
  return d;
};
export const tokenData = (mint: string, owner: string, amount: bigint) => {
  const d = new Uint8Array(165);
  d.set(bs58.decode(mint), 0);
  d.set(bs58.decode(owner), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  d[108] = 1;
  return d;
};

/** A tiny fake mainnet: a creator with SOL, USDC (bonding curve) and WSOL (PumpSwap) fees. */
export async function creatorFeeFixture() {
  const seed = new Uint8Array(32).fill(7),
    pair = nacl.sign.keyPair.fromSeed(seed),
    wallet = bs58.encode(pair.publicKey);
  const base = await creatorFeeAddresses(wallet);
  const usdc = await creatorFeeQuoteAddresses(wallet, {
    mint: USDC,
    tokenProgram: CLAIM_TOKEN,
  });
  const wsol = await creatorFeeQuoteAddresses(wallet, {
    mint: CLAIM_WSOL,
    tokenProgram: CLAIM_TOKEN,
  });
  const chain = new Map<string, Account>([
    [
      wallet,
      { lamports: 1_000_000_000n, owner: CLAIM_SYSTEM, data: new Uint8Array() },
    ],
    [USDC, { lamports: 1n, owner: CLAIM_TOKEN, data: mintData(6) }],
    [CLAIM_WSOL, { lamports: 1n, owner: CLAIM_TOKEN, data: mintData(9) }],
    [
      base.pumpVault,
      {
        lamports: 890_880n + 250_000_000n,
        owner: CLAIM_SYSTEM,
        data: new Uint8Array(),
      },
    ],
    [
      usdc.pumpTokenVault,
      {
        lamports: 2_039_280n,
        owner: CLAIM_TOKEN,
        data: tokenData(USDC, base.pumpVault, 12_500_000n),
      },
    ],
    [
      wsol.ammTokenVault,
      {
        lamports: 2_039_280n + 40_000_000n,
        owner: CLAIM_TOKEN,
        data: tokenData(CLAIM_WSOL, base.ammAuthority, 40_000_000n),
      },
    ],
  ]);
  // Post-simulation state overrides (address -> account | null).
  const after = new Map<string, Account | null>();
  const calls: { method: string; params: unknown[] }[] = [];
  const state = {
    simulationErr: null as unknown,
    blockhashValid: true,
    sendResult: null as string | null,
    transaction: null as unknown,
  };
  const view = (a: Account | null | undefined) =>
    a
      ? {
          lamports: Number(a.lamports),
          owner: a.owner,
          executable: false,
          data: [b64(a.data), 'base64'],
          rentEpoch: 0,
          space: a.data.length,
        }
      : null;
  const result = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case 'getGenesisHash':
        return SOLANA_MAINNET_GENESIS;
      case 'getMultipleAccounts':
        return {
          context: { slot: 1000 },
          value: (params[0] as string[]).map((k) => view(chain.get(k))),
        };
      case 'getMinimumBalanceForRentExemption':
        return params[0] === 0 ? 890_880 : 2_039_280;
      case 'getLatestBlockhash':
        return {
          context: { slot: 1001 },
          value: { blockhash: BLOCKHASH, lastValidBlockHeight: 5000 },
        };
      case 'getFeeForMessage':
        return { context: { slot: 1001 }, value: 5000 };
      case 'simulateTransaction': {
        const addresses = (params[1] as { accounts: { addresses: string[] } })
          .accounts.addresses;
        return {
          context: { slot: 1002 },
          value: {
            err: state.simulationErr,
            accounts: addresses.map((a) =>
              view(after.has(a) ? after.get(a) : chain.get(a)),
            ),
          },
        };
      }
      case 'isBlockhashValid':
        return { context: { slot: 1002 }, value: state.blockhashValid };
      case 'sendTransaction':
        return state.sendResult;
      case 'getTransaction':
        return state.transaction;
    }
    throw new Error('Unexpected RPC ' + method);
  };
  const fetcher = (async (_url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(init.body as string);
    calls.push({ method, params });
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: result(method, params) }),
    );
  }) as unknown as typeof fetch;
  // Expected effects of claiming all three vaults.
  after.set(wallet, {
    lamports: 1_000_000_000n - 5000n - 2_039_280n + 250_000_000n + 40_000_000n,
    owner: CLAIM_SYSTEM,
    data: new Uint8Array(),
  });
  after.set(usdc.destination, {
    lamports: 2_039_280n,
    owner: CLAIM_TOKEN,
    data: tokenData(USDC, wallet, 12_500_000n),
  });
  after.set(wsol.destination, null);
  return {
    seed,
    pair,
    wallet,
    base,
    usdc,
    wsol,
    chain,
    after,
    calls,
    state,
    fetcher,
    view,
  };
}
