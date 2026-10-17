import { address } from '@solana/kit';
import {
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { getSolanaRpcEndpoint } from './solana-rpc';
import { TOKEN_2022 } from './token-withdrawal-fee';
import {
  readSupplyMint,
  readSupplyTokenAccount,
} from './token-supply-action-server';

export const MAX_SEND_SOURCES = 25;
export type TokenSendSnapshot = {
  mint: string;
  program: string;
  decimals: number;
  supplyRaw: string;
  slot: number;
  balances: { address: string; raw: string }[];
};
type Account = {
  owner: string;
  executable: boolean;
  lamports: string | number;
  data: [string, string];
} | null;

/** One finalized read of the mint and every source wallet's associated token account, so the send plan is sized against a single snapshot. */
export async function tokenSendSnapshot(
  mint: string,
  wallets: string[],
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<TokenSendSnapshot> {
  if (wallets.length < 1 || wallets.length > MAX_SEND_SOURCES)
    throw new Error(`Choose 1 to ${MAX_SEND_SOURCES} source wallets.`);
  const endpoint = getSolanaRpcEndpoint('mainnet'),
    rpc = (method: string, params: unknown[]) =>
      balanceRpc(endpoint, method, params, signal, fetcher);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Send network differs.');
  const info = (await rpc('getAccountInfo', [
    mint,
    { encoding: 'base64', commitment: 'finalized' },
  ])) as { value: Account };
  const program = info?.value?.owner;
  if (program !== TOKEN_PROGRAM_ADDRESS && program !== TOKEN_2022)
    throw new Error('Unsupported token mint program.');
  const accounts = await Promise.all(
    wallets.map(
      async (owner) =>
        (
          await findAssociatedTokenPda({
            owner: address(owner),
            mint: address(mint),
            tokenProgram: address(program),
          })
        )[0],
    ),
  );
  const result = (await rpc('getMultipleAccounts', [
    [mint, ...accounts],
    { encoding: 'base64', commitment: 'finalized' },
  ])) as { context: { slot: number }; value: Account[] };
  if (
    !Array.isArray(result?.value) ||
    result.value.length !== accounts.length + 1
  )
    throw new Error('Incomplete token balances.');
  const parsed = readSupplyMint(result.value[0], program);
  return {
    mint,
    program,
    decimals: parsed.decimals,
    supplyRaw: parsed.supplyRaw.toString(),
    slot: Number(result.context.slot),
    balances: wallets.map((owner, i) => ({
      address: owner,
      raw: (result.value[i + 1]
        ? readSupplyTokenAccount(result.value[i + 1], program, mint, owner)
        : 0n
      ).toString(),
    })),
  };
}
