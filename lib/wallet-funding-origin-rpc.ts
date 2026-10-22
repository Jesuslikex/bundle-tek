import { paceWalletRpc } from './wallet-rpc-pacing';
import { parseBalanceJson, WalletRpcError } from './wallet-balances';
/** Historical evidence only: pacing uses the request budget; the fetch timeout starts AFTER pacing. */
export async function fundingOriginRpc(
  endpoint: string,
  method: string,
  params: unknown[],
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  await paceWalletRpc(endpoint, signal);
  signal.throwIfAborted();
  const current = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    redirect: 'error',
    cache: 'no-store',
    signal: current,
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new WalletRpcError(response.status);
  }
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      response.headers.get('content-type') ?? '',
    )
  ) {
    void response.body?.cancel().catch(() => {});
    throw Error('Funding history response unavailable.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error('Funding history response unavailable.');
  let size = 0,
    text = '',
    finished = false;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  current.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    while (true) {
      current.throwIfAborted();
      const chunk = await reader.read();
      current.throwIfAborted();
      if (chunk.done) {
        finished = true;
        break;
      }
      size += chunk.value.byteLength;
      if (size > 524288) throw Error('Funding history response unavailable.');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    current.removeEventListener('abort', cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
  const result = parseBalanceJson(text) as {
    jsonrpc?: unknown;
    id?: unknown;
    result?: unknown;
    error?: unknown;
  } | null;
  if (
    !result ||
    result.jsonrpc !== '2.0' ||
    result.id !== '1' ||
    (JSON.parse(text) as { id?: unknown }).id !== 1 ||
    result.error ||
    result.result === undefined
  )
    throw Error('Funding history response unavailable.');
  current.throwIfAborted();
  return result.result;
}
