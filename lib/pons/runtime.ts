import { createPublicClient, http } from 'viem';
import { PonsError } from './intent';
export const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
const methods = new Set([
  'eth_chainId',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_call',
  'eth_getBalance',
  'eth_getTransactionCount',
  'eth_gasPrice',
  'eth_estimateGas',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
]);
export async function safeRpcFetch(
  input: string | URL | Request,
  init?: RequestInit,
  outerSignal?: AbortSignal,
): Promise<Response> {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (url !== RPC_URL && url !== RPC_URL + '/')
    throw new PonsError(502, 'RPC_HOST_DENIED');
  if (typeof init?.body !== 'string')
    throw new PonsError(502, 'RPC_BODY_DENIED');
  const payload = JSON.parse(init.body);
  if (Array.isArray(payload) || !methods.has(payload.method))
    throw new PonsError(502, 'RPC_METHOD_DENIED');
  const controller = new AbortController();
  const stop = () => controller.abort();
  init?.signal?.addEventListener('abort', stop, { once: true });
  outerSignal?.addEventListener('abort', stop, { once: true });
  if (init?.signal?.aborted || outerSignal?.aborted) stop();
  const timer = setTimeout(stop, 15000);
  try {
    const response = await fetch(input, {
      ...init,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new PonsError(502, 'RPC_HTTP_FAILED');
    }
    if (Number(response.headers.get('content-length')) > 1048576) {
      await response.body?.cancel();
      throw new PonsError(502, 'RPC_RESPONSE_TOO_LARGE');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new PonsError(502, 'RPC_EMPTY_RESPONSE');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 1048576)
          throw new PonsError(502, 'RPC_RESPONSE_TOO_LARGE');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    return new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } finally {
    clearTimeout(timer);
    init?.signal?.removeEventListener('abort', stop);
    outerSignal?.removeEventListener('abort', stop);
  }
}
export function ponsClient(signal?: AbortSignal) {
  return createPublicClient({
    transport: http(RPC_URL, {
      fetchFn: (input, init) => safeRpcFetch(input, init, signal),
      timeout: 15000,
      retryCount: 0,
      batch: false,
      maxResponseBodySize: 1048576,
    }),
  });
}
