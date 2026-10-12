import { parseBalanceJson, WalletRpcError } from './wallet-balances';
import { TOKEN_PROGRAMS } from './wallet-holdings';
import { HoldingsBatchError } from './holdings-batch-error';
type Pending = {
  call: { jsonrpc: string; id: number; method: string; params: unknown[] };
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
};
/** Request-local adapter for the existing complete holdings reader. */
export function createHoldingsGroupFetcher(
  fetcher: typeof fetch = fetch,
): typeof fetch {
  let endpoint: string | undefined, signal: AbortSignal | null | undefined;
  const shared = new Map<string, Promise<Response>>(),
    pairs = new Map<string, Pending[]>();
  async function sendBatch(
    url: RequestInfo | URL,
    init: RequestInit,
    list: Pending[],
  ) {
    try {
      const response = await fetcher(url, {
        ...init,
        body: JSON.stringify(
          list.map((p, i) => ({ ...p.call, id: `holdings-${i}` })),
        ),
        redirect: 'manual',
        cache: 'no-store',
      });
      if (!response.ok) throw new WalletRpcError(response.status);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty holdings batch.');
      const decoder = new TextDecoder();
      let text = '',
        size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1048576) {
            await reader.cancel();
            throw new HoldingsBatchError('BATCH_TOO_LARGE');
          }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      const data = parseBalanceJson(text);
      if (!Array.isArray(data) || data.length !== list.length)
        throw new Error('Incomplete holdings batch.');
      const seen = new Set<string>();
      const responses = list.map((_, index) => {
        const id = `holdings-${index}`,
          matches = data.filter((row) => row?.id === id);
        if (matches.length !== 1)
          throw new Error('Holdings batch response IDs differ.');
        const row = matches[0];
        if (
          row.jsonrpc !== '2.0' ||
          row.error !== undefined ||
          row.result === undefined ||
          seen.has(id)
        )
          throw new HoldingsBatchError(
            row.error !== undefined ? 'BATCH_RPC_ERROR' : 'INVALID_BATCH',
          );
        seen.add(id);
        const body = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: row.result,
        });
        if (new TextEncoder().encode(body).length > 524288)
          throw new HoldingsBatchError('RESULT_TOO_LARGE');
        return new Response(body, {
          headers: { 'content-type': 'application/json' },
        });
      });
      responses.forEach((response, index) => list[index].resolve(response));
    } catch (error) {
      const safe =
        error instanceof WalletRpcError || error instanceof HoldingsBatchError
          ? error
          : new HoldingsBatchError('INVALID_BATCH');
      list.forEach((p) => p.reject(safe));
    }
  }
  return (async (url, init) => {
    if (
      !init ||
      init.method !== 'POST' ||
      typeof init.body !== 'string' ||
      !init.signal
    )
      throw new Error('Invalid holdings transport request.');
    init.signal.throwIfAborted();
    const current =
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (endpoint === undefined) {
      endpoint = current;
      signal = init.signal;
    }
    if (endpoint !== current || signal !== init.signal)
      throw new Error('Group holdings transport context changed.');
    const call = JSON.parse(init.body) as Pending['call'];
    if (call.jsonrpc !== '2.0' || call.id !== 1 || !Array.isArray(call.params))
      throw new Error('Invalid holdings RPC request.');
    if (call.method === 'getGenesisHash' || call.method === 'getSlot') {
      const key = call.method + JSON.stringify(call.params);
      let response = shared.get(key);
      if (!response) {
        response = fetcher(url, init);
        shared.set(key, response);
      }
      return (await response).clone();
    }
    const owner = call.params[0],
      program = (call.params[1] as { programId?: string })?.programId;
    if (
      call.method !== 'getTokenAccountsByOwner' ||
      typeof owner !== 'string' ||
      !TOKEN_PROGRAMS.includes(program as (typeof TOKEN_PROGRAMS)[number])
    )
      throw new Error('Unsupported group holdings RPC method.');
    return new Promise<Response>((resolve, reject) => {
      const list = pairs.get(owner) ?? [];
      if (
        list.some(
          (p) =>
            (p.call.params[1] as { programId: string }).programId === program,
        )
      ) {
        list.forEach((p) =>
          p.reject(new Error('Duplicate holdings program request.')),
        );
        pairs.delete(owner);
        reject(new Error('Duplicate holdings program request.'));
        return;
      }
      list.push({ call, resolve, reject });
      if (list.length === 2) {
        pairs.delete(owner);
        void sendBatch(url, init, list);
      } else {
        pairs.set(owner, list);
        const abort = () => {
          if (pairs.get(owner) === list) {
            pairs.delete(owner);
            list.forEach((p) => p.reject(init.signal!.reason));
          }
        };
        init.signal!.addEventListener('abort', abort, { once: true });
        // Resolve/reject always detaches the pair's abort listener.
        const pending = list[0],
          completeResolve = pending.resolve,
          completeReject = pending.reject;
        pending.resolve = (response) => {
          init.signal!.removeEventListener('abort', abort);
          completeResolve(response);
        };
        pending.reject = (error) => {
          init.signal!.removeEventListener('abort', abort);
          completeReject(error);
        };
        if (init.signal!.aborted) abort();
      }
    });
  }) as typeof fetch;
}
