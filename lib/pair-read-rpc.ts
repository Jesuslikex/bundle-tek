import { parseBalanceJson, WalletRpcError } from './wallet-balances';
import { paceWalletRpc } from './wallet-rpc-pacing';
type Pending = {
  id: string;
  method: string;
  params: unknown[];
  maxBytes: number;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};
const NORMAL = 524288,
  CODE = 2097152;
const METHODS = new Set([
  'getGenesisHash',
  'getSlot',
  'getBlockHeight',
  'getMultipleAccounts',
  'getFeeForMessage',
  'isBlockhashValid',
  'simulateTransaction',
]);
async function cancellable<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abort = () => {};
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        abort = () =>
          reject(new DOMException('Pair RPC read cancelled.', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
async function boundedBody(
  response: Response,
  bound: number,
  signal: AbortSignal,
) {
  const reader = response.body?.getReader();
  if (!reader) throw Error('Empty pair RPC response.');
  let size = 0,
    text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    for (;;) {
      const part = await cancellable(reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > bound) {
        void reader.cancel().catch(() => {});
        throw Error('Pair RPC response exceeds bounds.');
      }
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    try {
      reader.releaseLock();
    } catch {
      /* An aborted provider stream may still have a pending read. */
    }
  }
}
/** Request-scoped read transport. It never caches results or retries; group signing does not use it. */
export function createPairReadRpc(
  endpoint: string,
  outerSignal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      endpoint.length > 4096
    )
      throw Error();
  } catch {
    throw Error('Invalid pair RPC endpoint.');
  }
  const controller = new AbortController(),
    signal = AbortSignal.any([outerSignal, controller.signal]);
  const queue: Pending[] = [],
    active = new Set<Pending[]>();
  // Declared lengths are untrusted packing hints only. No account bytes, slots,
  // identity evidence or results are reused, including during the final recheck.
  const lengths = new Map<string, number>();
  let sequence = 0,
    scheduled = false,
    terminal: Error | undefined;
  function stop(error: unknown) {
    if (terminal) return;
    terminal =
      error instanceof WalletRpcError
        ? error
        : outerSignal.aborted
          ? new DOMException('Pair RPC read cancelled.', 'AbortError')
          : Error('Pair RPC batch read failed.');
    controller.abort();
    for (const item of queue.splice(0)) item.reject(terminal);
    for (const batch of active) for (const item of batch) item.reject(terminal);
  }
  const abort = () =>
    stop(new DOMException('Pair RPC read cancelled.', 'AbortError'));
  outerSignal.addEventListener('abort', abort, { once: true });
  if (outerSignal.aborted) abort();
  function rawEstimate(item: Pending) {
    if (item.method !== 'getMultipleAccounts') return 0;
    const keys = item.params[0] as string[],
      config = item.params[1] as {
        dataSlice?: { offset: number; length: number };
      };
    if (!config.dataSlice) return item.maxBytes;
    const slice = config.dataSlice;
    return keys.reduce(
      (sum, key) =>
        sum +
        Math.min(
          slice.length,
          Math.max(
            0,
            (lengths.get(key) ?? slice.offset + slice.length) - slice.offset,
          ),
        ),
      0,
    );
  }
  function estimate(item: Pending) {
    if (item.method === 'simulateTransaction') return item.maxBytes;
    if (item.method !== 'getMultipleAccounts') return 2048;
    const keys = item.params[0] as string[],
      config = item.params[1] as {
        dataSlice?: { offset: number; length: number };
      };
    if (!config.dataSlice) {
      // Packing hint only: selected wallet/Clock/Rent accounts are usually
      // small. The original whole-envelope limits remain unchanged and fail
      // closed if this estimate is low, before publishing any result.
      return Math.min(
        item.maxBytes,
        keys.reduce(
          (sum, key) =>
            sum + Math.ceil((lengths.get(key) ?? 65536) / 3) * 4 + 512,
          1024,
        ),
      );
    }
    const slice = config.dataSlice;
    const bytes = keys.reduce((sum, key) => {
      const size = lengths.get(key),
        raw =
          size === undefined
            ? slice.length
            : Math.min(slice.length, Math.max(0, size - slice.offset));
      return sum + Math.ceil(raw / 3) * 4 + 512;
    }, 1024);
    return Math.min(item.maxBytes, bytes);
  }
  function schedule() {
    if (scheduled || terminal) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      flush();
    });
  }
  function flush() {
    if (terminal) return;
    while (queue.length && active.size < 4) {
      const batch = [queue.shift()!],
        next = queue[0];
      // Enforce the smallest constituent bound on the *whole* response. Thus
      // no individual response can exceed its former single-read byte limit.
      if (
        next &&
        rawEstimate(batch[0]) + rawEstimate(next) <= 1024 * 1024 &&
        estimate(batch[0]) + estimate(next) + 512 <=
          Math.min(batch[0].maxBytes, next.maxBytes)
      )
        batch.push(queue.shift()!);
      active.add(batch);
      void dispatch(batch)
        .catch(stop)
        .finally(() => {
          active.delete(batch);
          schedule();
        });
    }
  }
  async function dispatch(batch: Pending[]) {
    await paceWalletRpc(endpoint, signal);
    signal.throwIfAborted();
    const messages = batch.map((item) => ({
      jsonrpc: '2.0',
      id: item.id,
      method: item.method,
      params: item.params,
    }));
    const response = await cancellable(
      fetcher(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        redirect: 'manual',
        cache: 'no-store',
        signal,
        body: JSON.stringify(batch.length === 1 ? messages[0] : messages),
      }).then((response) => {
        if (signal.aborted) void response.body?.cancel().catch(() => {});
        return response;
      }),
      signal,
    );
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new WalletRpcError(response.status);
    }
    const parsed = parseBalanceJson(
      await boundedBody(
        response,
        Math.min(...batch.map((item) => item.maxBytes)),
        signal,
      ),
    );
    const replies = batch.length === 1 ? [parsed] : parsed;
    if (!Array.isArray(replies) || replies.length !== batch.length)
      throw Error('Pair RPC response mapping differs.');
    const results = new Map<string, unknown>();
    for (const [index, raw] of replies.entries()) {
      const reply = raw as {
        jsonrpc?: unknown;
        id?: unknown;
        result?: unknown;
        error?: unknown;
      };
      if (
        !reply ||
        reply.jsonrpc !== '2.0' ||
        typeof reply.id !== 'string' ||
        reply.id !== batch[index].id ||
        !batch.some((item) => item.id === reply.id) ||
        results.has(reply.id) ||
        reply.error ||
        reply.result === undefined
      )
        throw Error('Pair RPC response mapping differs.');
      const item = batch[index];
      const config = item.params[
        ['getSlot', 'getBlockHeight'].includes(item.method) ? 0 : 1
      ] as { minContextSlot?: number } | undefined;
      if (
        config?.minContextSlot !== undefined &&
        [
          'getSlot',
          'getMultipleAccounts',
          'getFeeForMessage',
          'isBlockhashValid',
          'simulateTransaction',
        ].includes(item.method)
      ) {
        const rawSlot =
          item.method === 'getSlot'
            ? reply.result
            : (reply.result as { context?: { slot?: unknown } } | null)?.context
                ?.slot;
        if (
          typeof rawSlot !== 'string' ||
          !/^\d{1,16}$/.test(rawSlot) ||
          !Number.isSafeInteger(Number(rawSlot)) ||
          Number(rawSlot) < config.minContextSlot ||
          Number(rawSlot) > config.minContextSlot + 32
        )
          throw Error('Pair RPC response context differs.');
      }
      results.set(reply.id, reply.result);
    }
    signal.throwIfAborted();
    // Size hints never authorize extra raw code. Check actual decoded lengths
    // across the whole HTTP envelope before publishing any constituent result.
    if (batch.some((item) => item.maxBytes === CODE)) {
      let rawBytes = 0;
      for (const item of batch) {
        if (item.method !== 'getMultipleAccounts') continue;
        const result = results.get(item.id) as { value?: unknown[] };
        if (!Array.isArray(result?.value)) continue;
        for (const account of result.value) {
          const data = (account as { data?: unknown[] } | null)?.data;
          if (
            Array.isArray(data) &&
            typeof data[0] === 'string' &&
            data[1] === 'base64'
          )
            rawBytes += Buffer.byteLength(data[0], 'base64');
          if (rawBytes > 1024 * 1024)
            throw Error('Pair RPC raw response exceeds bounds.');
        }
      }
    }
    // Update size hints only after every response ID and result has passed.
    for (const item of batch) {
      if (item.method !== 'getMultipleAccounts') continue;
      const result = results.get(item.id) as { value?: unknown[] };
      const keys = item.params[0] as string[];
      if (!Array.isArray(result?.value) || result.value.length !== keys.length)
        continue;
      for (const [i, key] of keys.entries()) {
        const space = (result.value[i] as { space?: unknown } | null)?.space;
        if (
          typeof space === 'string' &&
          /^(0|[1-9]\d{0,8})$/.test(space) &&
          Number(space) <= 10 * 1024 * 1024 + 45 &&
          (lengths.has(key) || lengths.size < 256)
        )
          lengths.set(key, Number(space));
      }
    }
    if (terminal) throw terminal;
    for (const item of batch) item.resolve(results.get(item.id));
  }
  function read(
    method: string,
    params: unknown[],
    maxBytes: number,
  ): Promise<unknown> {
    if (terminal) return Promise.reject(terminal);
    try {
      signal.throwIfAborted();
      if (
        !METHODS.has(method) ||
        !Array.isArray(params) ||
        queue.length + Array.from(active).reduce((n, b) => n + b.length, 0) >=
          64
      )
        throw Error('Pair RPC read scope differs.');
      const serialized = JSON.stringify(params);
      if (new TextEncoder().encode(serialized).byteLength > 32768)
        throw Error('Pair RPC request exceeds bounds.');
      const copy = JSON.parse(serialized) as unknown[];
      const config = copy[
        ['getSlot', 'getBlockHeight'].includes(method) ? 0 : 1
      ] as { minContextSlot?: unknown } | undefined;
      if (
        config?.minContextSlot !== undefined &&
        (!Number.isSafeInteger(config.minContextSlot) ||
          Number(config.minContextSlot) < 0)
      )
        throw Error('Pair RPC context floor differs.');
      if (method === 'getMultipleAccounts') {
        const keys = copy[0] as unknown[],
          config = copy[1] as {
            encoding?: unknown;
            dataSlice?: { offset?: unknown; length?: unknown };
          };
        if (
          !Array.isArray(keys) ||
          !keys.length ||
          keys.length > 100 ||
          keys.some(
            (k) =>
              typeof k !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(k),
          ) ||
          config?.encoding !== 'base64'
        )
          throw Error('Pair RPC account scope differs.');
        const slice = config.dataSlice;
        if (
          slice &&
          (!Number.isSafeInteger(slice.offset) ||
            Number(slice.offset) < 0 ||
            Number(slice.offset) > 10 * 1024 * 1024 + 45 ||
            !Number.isSafeInteger(slice.length) ||
            Number(slice.length) < 1 ||
            Number(slice.length) > 720 * 1024)
        )
          throw Error('Pair RPC slice scope differs.');
      }
      if (method === 'simulateTransaction') {
        const config = copy[1] as {
          sigVerify?: unknown;
          replaceRecentBlockhash?: unknown;
        };
        if (
          config?.sigVerify !== false ||
          config.replaceRecentBlockhash !== false
        )
          throw Error('Pair RPC simulation scope differs.');
      }
      return new Promise((resolve, reject) => {
        queue.push({
          id: 'pair-' + ++sequence,
          method,
          params: copy,
          maxBytes,
          resolve,
          reject,
        });
        schedule();
      });
    } catch (error) {
      stop(error);
      return Promise.reject(terminal);
    }
  }
  return {
    rpc: (method: string, params: unknown[]) => read(method, params, NORMAL),
    programRpc: (method: string, params: unknown[]) =>
      read(method, params, CODE),
    close() {
      outerSignal.removeEventListener('abort', abort);
      stop(Error('Pair RPC transport closed.'));
      lengths.clear();
    },
  };
}
