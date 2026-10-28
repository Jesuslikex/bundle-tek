// Do not retain provider error text or silently retry a rate-limited campaign.
export function markStockRpcRateLimit(error, receipt, stop) {
  if (!error || error.status !== 429) return false;
  receipt.rateLimited = true;
  if (error.rpcRateLimited === true) receipt.rpcRateLimited = true;
  stop.abort(Error('RPC rate limit; no retry.'));
  return true;
}

// The post-attempt reference audit uses balanceRpc directly, not the normal
// recorded read wrapper. Preserve the same terminal rate-limit behavior there.
export async function auditStockReferenceRpc(
  balanceRpc,
  endpoint,
  method,
  params,
  signal,
  fetcher,
  receipt,
  stop,
) {
  try {
    return await balanceRpc(endpoint, method, params, signal, fetcher);
  } catch (error) {
    markStockRpcRateLimit(error, receipt, stop);
    throw error;
  }
}
