import { env } from '@/lib/server-env';

type RpcEnvelope<T> = { result?: T; error?: { code: number; message: string } };

export const MAX_SOLANA_SLOT_DRIFT = 32;

export function requireConsistentSolanaSlots(slots: number[]) {
  if (
    !slots.length ||
    slots.some((slot) => !Number.isSafeInteger(slot) || slot < 0)
  ) {
    throw new Error('Solana RPC returned an invalid context slot');
  }
  const oldest = Math.min(...slots);
  const newest = Math.max(...slots);
  if (newest - oldest > MAX_SOLANA_SLOT_DRIFT) {
    throw new Error(
      `Solana RPC snapshot crossed too many slots (${oldest}-${newest})`,
    );
  }
  return newest;
}

export async function rpcCall<T>(
  endpoint: string,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(12_000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok)
    throw new Error(`RPC ${method} returned ${response.status}`);
  const payload = (await response.json()) as RpcEnvelope<T>;
  if (payload.error) throw new Error(payload.error.message);
  if (payload.result === undefined)
    throw new Error(`RPC ${method} returned no result`);
  return payload.result;
}

export function getSolanaRpcEndpoint(network: 'devnet' | 'mainnet') {
  return network === 'devnet'
    ? env.SOLANA_DEVNET_RPC_URL || 'https://api.devnet.solana.com'
    : env.SOLANA_MAINNET_RPC_URL || 'https://solana-rpc.publicnode.com';
}

export function getSolanaIndexerRpcEndpoint() {
  return (
    env.SOLANA_INDEXER_RPC_URL ||
    env.SOLANA_MAINNET_RPC_URL ||
    'https://api.mainnet.solana.com'
  );
}

export function getSolanaHolderRpcEndpoint() {
  const configured = env.SOLANA_HOLDER_RPC_URL;
  if (!configured) return getSolanaIndexerRpcEndpoint();
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('Invalid holder RPC configuration.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error(
      'Holder RPC must use HTTPS without user-info or a fragment.',
    );
  return configured;
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
