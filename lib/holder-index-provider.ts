import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { getSolanaIndexerRpcEndpoint } from './solana-rpc';
import { decodeHolderIndexPage, HOLDER_INDEX_PAGE_SIZE } from './holder-index';

export async function observeHolderIndexPage(
  mint: string,
  page: number,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const endpoint = getSolanaIndexerRpcEndpoint();
  const rpc = (method: string, params: unknown[] | Record<string, unknown>) =>
    balanceRpc(endpoint, method, params, signal, fetcher, 1_048_576);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Holder network differs.');
  const supply = await rpc('getTokenSupply', [
    mint,
    { commitment: 'confirmed' },
  ]);
  const result = await rpc('getTokenAccounts', {
    mint,
    page,
    limit: HOLDER_INDEX_PAGE_SIZE,
    options: { showZeroBalance: false },
  });
  return decodeHolderIndexPage(
    result,
    supply,
    mint,
    page,
    new URL(endpoint).hostname,
  );
}
