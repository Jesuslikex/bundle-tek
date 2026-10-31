import { address } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import { MARKET_CLEANUP_MAX_WALLETS } from './market-cleanup';

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export type CleanupBalanceRpc = (
  method: string,
  params: unknown[],
  signal: AbortSignal,
) => Promise<unknown>;
export type CleanupBalanceRow = {
  wallet: string;
  tokenRaw: string;
  lamports: string;
};
type Parsed = {
  lamports?: number;
  data?: {
    parsed?: {
      info?: {
        mint?: string;
        owner?: string;
        tokenAmount?: { amount?: string };
      };
    };
  };
} | null;
const fail = (message: string): never => {
  throw new Error(message);
};

/**
 * One read-only getMultipleAccounts call: each wallet's SOL plus its classic
 * SPL and Token-2022 associated accounts for the coin.
 */
export async function readCleanupBalances(
  rpc: CleanupBalanceRpc,
  mint: string,
  wallets: string[],
  signal: AbortSignal,
): Promise<CleanupBalanceRow[]> {
  if (!wallets.length || wallets.length > MARKET_CLEANUP_MAX_WALLETS * 2)
    fail('Choose the Cleanup wallets to read.');
  const atas = async (program: string) =>
    Promise.all(
      wallets.map(async (owner) =>
        String(
          (
            await findAssociatedTokenPda({
              owner: address(owner),
              mint: address(mint),
              tokenProgram: address(program),
            })
          )[0],
        ),
      ),
    );
  const [spl, t22] = await Promise.all([
    atas(TOKEN_PROGRAM),
    atas(TOKEN_2022_PROGRAM),
  ]);
  const keys = [...wallets, ...spl, ...t22];
  const result = (await rpc(
    'getMultipleAccounts',
    [keys, { encoding: 'jsonParsed', commitment: 'confirmed' }],
    signal,
  )) as { value?: Parsed[] };
  if (!Array.isArray(result?.value) || result.value.length !== keys.length)
    fail('Cleanup balances differ.');
  const n = wallets.length;
  const tokens = (account: Parsed, wallet: string) => {
    if (!account) return 0n;
    const info = account.data?.parsed?.info;
    if (info?.mint !== mint || info?.owner !== wallet)
      fail('Cleanup token account differs.');
    const amount = info?.tokenAmount?.amount;
    if (typeof amount !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(amount))
      fail('Cleanup token balance differs.');
    return BigInt(amount as string);
  };
  return wallets.map((wallet, i) => {
    const native = result.value![i];
    const lamports = native?.lamports ?? 0;
    if (!Number.isSafeInteger(lamports) || lamports < 0)
      fail('Cleanup SOL balance differs.');
    return {
      wallet,
      lamports: String(lamports),
      tokenRaw: (
        tokens(result.value![n + i], wallet) +
        tokens(result.value![2 * n + i], wallet)
      ).toString(),
    };
  });
}
