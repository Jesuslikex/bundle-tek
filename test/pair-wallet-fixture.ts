import bs58 from 'bs58';
import { readFileSync } from 'node:fs';
import {
  getExtensionEncoder,
  type ExtensionArgs,
} from '@solana-program/token-2022';
import {
  importedPairQuoteFixture,
  pairQuoteClock,
} from './imported-pair-quote-fixture';
import { readPairMintEvidence, PAIR_CLOCK } from '../lib/pair-mint-evidence';
import { PAIR_RENT } from '../lib/pair-rent-evidence';
import { pairRentAccount } from './pair-rent-fixture';
import {
  pairAssociatedAddress,
  requiredPairAccountExtensions,
} from '../lib/pair-wallet-evidence';
import type { ImportedPairWalletRequest } from '../lib/imported-pair-wallet-preflight';
const SYSTEM = '11111111111111111111111111111111';
export function pairWalletTokenAccount(
  mint: string,
  wallet: string,
  program: string,
  amountRaw: string,
  extensions: ExtensionArgs[] = [],
) {
  const encoded = extensions.map((e) => getExtensionEncoder().encode(e));
  const bytes = new Uint8Array(
      encoded.length ? 166 + encoded.reduce((n, e) => n + e.length, 0) : 165,
    ),
    view = new DataView(bytes.buffer);
  bytes.set(bs58.decode(mint), 0);
  bytes.set(bs58.decode(wallet), 32);
  view.setBigUint64(64, BigInt(amountRaw), true);
  bytes[108] = 1;
  if (encoded.length) {
    bytes[165] = 2;
    let offset = 166;
    for (const e of encoded) {
      bytes.set(e, offset);
      offset += e.length;
    }
  }
  return {
    owner: program,
    executable: false,
    lamports: '20000000',
    data: [btoa(String.fromCharCode(...bytes)), 'base64'],
  };
}
export async function pairWalletFixture(side: 'Buy' | 'Sell' = 'Buy') {
  const f = importedPairQuoteFixture(side);
  f.sqlite.exec(readFileSync('drizzle/0011_huge_donald_blake.sql', 'utf8'));
  const wallet = bs58.encode(new Uint8Array(32).fill(7));
  const clock = { now: Math.floor(Date.now() / 1000) * 1000 };
  f.dependencies.now = () => clock.now;
  const originalQuote = f.quote.getMockImplementation()!;
  f.quote.mockImplementation(async (...args) => ({
    ...(await originalQuote(...args)),
    observedAt: new Date(clock.now).toISOString(),
    expiresAt: new Date(clock.now + 30000).toISOString(),
  }));
  f.mints[1] = JSON.parse(
    readFileSync('test/tslax-mainnet-mint-20261015.json', 'utf8'),
  ).account;
  f.sqlite
    .prepare(
      'INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,label,role,archived,revision,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    )
    .run(
      'alice',
      'Solana',
      wallet,
      crypto.randomUUID(),
      'Synthetic pair wallet',
      'Recipient',
      0,
      1,
      new Date(clock.now).toISOString(),
    );
  const mints = await readPairMintEvidence(
    { inputMint: f.baseMint, outputMint: f.asset.address },
    100,
    f.rpc,
    clock.now,
  );
  const atas = await Promise.all(
    mints.mints.map((m) => pairAssociatedAddress(m, wallet)),
  );
  const accounts: (ReturnType<typeof pairWalletTokenAccount> | null)[] =
    mints.mints.map((m, i) =>
      pairWalletTokenAccount(
        m.address,
        wallet,
        m.program,
        i === 0 ? '20000000' : '500000000',
        requiredPairAccountExtensions(m),
      ),
    );
  const state = {
    walletAccount: {
      owner: SYSTEM,
      executable: false,
      lamports: '1000000000',
      data: ['', 'base64'],
    } as {
      owner: string;
      executable: boolean;
      lamports: string;
      data: string[];
    } | null,
    walletReads: 0,
    onWalletRead: null as null | ((read: number) => void),
    rentAccount: pairRentAccount(),
  };
  const original = f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async (method, params) => {
    if (method === 'getMinimumBalanceForRentExemption') {
      const size = params[0] as number;
      return String((128 + size) * 10);
    }
    if (
      method === 'getMultipleAccounts' &&
      (params[0] as string[])[0] === wallet
    ) {
      state.walletReads++;
      state.onWalletRead?.(state.walletReads);
      const slot = (params[1] as { minContextSlot: number }).minContextSlot + 1;
      return {
        context: { slot: String(slot) },
        value: (params[0] as string[]).map((a, i, keys) =>
          a === wallet
            ? structuredClone(state.walletAccount)
            : a === PAIR_CLOCK
              ? pairQuoteClock(slot, String(Math.floor(clock.now / 1000)))
              : a === PAIR_RENT
                ? structuredClone(state.rentAccount)
                : keys.at(-1) === PAIR_CLOCK &&
                    keys.length >= 6 &&
                    i >= keys.length - 4 &&
                    i < keys.length - 2
                  ? structuredClone(f.mints[i - (keys.length - 4)])
                  : structuredClone(accounts[atas.indexOf(a)] ?? null),
        ),
      };
    }
    return original(method, params);
  });
  f.rpc.mockClear();
  const request: ImportedPairWalletRequest = {
    ...f.request,
    wallet,
    walletRevision: 1,
    feeAndRentLimitRaw: '10000000',
  };
  return {
    ...f,
    wallet,
    clock,
    atas,
    accounts,
    state,
    mintEvidence: mints,
    walletRequest: request,
  };
}
