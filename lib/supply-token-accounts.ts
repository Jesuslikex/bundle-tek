import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { getSolanaIndexerRpcEndpoint } from './solana-rpc';
import { walletAddress } from './wallet-workspace';
import { TOKEN_PROGRAMS } from './wallet-holdings';
export type SupplyTokenAccounts = {
  wallet: string;
  mint: string;
  decimals: number;
  slot: number;
  accounts: string[];
  source: string;
  observedAt: string;
};
export async function observeSupplyTokenAccounts(
  wallet: string,
  mint: string,
  decimals: number,
  minimumSlot: number,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SupplyTokenAccounts> {
  wallet = walletAddress(wallet, 'Solana');
  mint = walletAddress(mint, 'Solana');
  if (
    !Number.isSafeInteger(minimumSlot) ||
    minimumSlot < 0 ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  )
    throw new Error('Invalid token account context.');
  const endpoint = getSolanaIndexerRpcEndpoint();
  const rpc = (method: string, params: unknown[]) =>
    balanceRpc(endpoint, method, params, signal, fetcher);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Token account provider network mismatch.');
  const result = (await rpc('getTokenAccountsByOwner', [
    wallet,
    { mint },
    {
      encoding: 'jsonParsed',
      commitment: 'finalized',
      minContextSlot: minimumSlot,
    },
  ])) as { context?: { slot?: unknown }; value?: unknown[] };
  const rawSlot = result?.context?.slot;
  if (
    typeof rawSlot !== 'string' ||
    !/^(0|[1-9]\d*)$/.test(rawSlot) ||
    !Number.isSafeInteger(Number(rawSlot)) ||
    Number(rawSlot) < minimumSlot ||
    !Array.isArray(result?.value) ||
    result.value.length > 500
  )
    throw new Error('Token account enumeration unavailable or exceeds limits.');
  const accounts = result.value.map((value) => {
    const row = value as {
      pubkey?: unknown;
      account?: {
        owner?: unknown;
        executable?: unknown;
        data?: {
          parsed?: {
            type?: unknown;
            info?: {
              owner?: unknown;
              mint?: unknown;
              state?: unknown;
              tokenAmount?: { decimals?: unknown; amount?: unknown };
            };
          };
        };
      };
    };
    const account = row?.account,
      parsed = account?.data?.parsed,
      info = parsed?.info;
    if (
      !TOKEN_PROGRAMS.includes(
        account?.owner as (typeof TOKEN_PROGRAMS)[number],
      ) ||
      account?.executable !== false ||
      parsed?.type !== 'account' ||
      info?.owner !== wallet ||
      info?.mint !== mint ||
      !['initialized', 'frozen'].includes(String(info?.state)) ||
      String(info?.tokenAmount?.decimals) !== String(decimals) ||
      typeof info?.tokenAmount?.amount !== 'string' ||
      !/^(0|[1-9]\d{0,19})$/.test(info.tokenAmount.amount) ||
      BigInt(info.tokenAmount.amount) > (1n << 64n) - 1n
    )
      throw new Error('Token account does not match wallet and mint.');
    return walletAddress(row.pubkey, 'Solana');
  });
  if (new Set(accounts).size !== accounts.length)
    throw new Error('Duplicate token accounts.');
  return {
    wallet,
    mint,
    decimals,
    slot: Number(rawSlot),
    accounts,
    source: new URL(endpoint).hostname,
    observedAt: new Date().toISOString(),
  };
}
