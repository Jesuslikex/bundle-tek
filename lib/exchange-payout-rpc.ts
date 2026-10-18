import { balanceRpc } from './wallet-balances';
import {
  ExchangePayoutError,
  type ExchangePayoutRpc,
} from './exchange-payout-receipt';
const methods = new Set([
  'getGenesisHash',
  'getSignatureStatuses',
  'getTransaction',
  'getSlot',
]);
export async function cancelExchangePayoutRead<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abort = () => {};
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        abort = () =>
          reject(
            new ExchangePayoutError(
              'Payout verification cancelled or timed out. Reload saved evidence before retrying.',
              503,
            ),
          );
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
/** Server-owned endpoint only. Ordinary wallet pacing, bounded lossless JSON, no retries. */
export function createExchangePayoutRpc(
  endpoint: string,
  fetcher: typeof fetch = fetch,
): ExchangePayoutRpc {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw Error();
  } catch {
    throw new ExchangePayoutError(
      'Payout RPC configuration is unavailable.',
      503,
    );
  }
  return async (method, params, signal) => {
    signal.throwIfAborted();
    if (
      !methods.has(method) ||
      !Array.isArray(params) ||
      new TextEncoder().encode(JSON.stringify(params)).byteLength > 4096
    )
      throw new ExchangePayoutError(
        'Only bounded payout evidence reads are allowed.',
        400,
      );
    return cancelExchangePayoutRead(
      balanceRpc(endpoint, method, params, signal, fetcher, 524288),
      signal,
    );
  };
}
