import { env } from 'cloudflare:workers';

type RpcEnvelope<T> = { result?: T; error?: { code: number; message: string } };

export async function rpcCall<T>(endpoint: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`RPC ${method} returned ${response.status}`);
  const payload = (await response.json()) as RpcEnvelope<T>;
  if (payload.error) throw new Error(payload.error.message);
  if (payload.result === undefined) throw new Error(`RPC ${method} returned no result`);
  return payload.result;
}

export function getSolanaRpcEndpoint(network: 'devnet' | 'mainnet') {
  return network === 'devnet'
    ? env.SOLANA_DEVNET_RPC_URL || 'https://rpc.ankr.com/solana_devnet'
    : env.SOLANA_MAINNET_RPC_URL || 'https://solana-rpc.publicnode.com';
}

export function getSolanaIndexerRpcEndpoint() {
  return env.SOLANA_INDEXER_RPC_URL || env.SOLANA_MAINNET_RPC_URL || 'https://api.mainnet.solana.com';
}

export async function getSolanaSnapshot(network: 'devnet' | 'mainnet') {
  const endpoint = getSolanaRpcEndpoint(network);
  const startedAt = Date.now();
  const latest = await rpcCall<{
    context: { slot: number };
    value: { blockhash: string; lastValidBlockHeight: number };
  }>(endpoint, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  return {
    network,
    status: 'online' as const,
    slot: latest.context.slot,
    blockhash: latest.value.blockhash,
    lastValidBlockHeight: latest.value.lastValidBlockHeight,
    latencyMs: Date.now() - startedAt,
  };
}
