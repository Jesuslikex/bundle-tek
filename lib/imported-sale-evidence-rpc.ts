import { balanceRpc } from './wallet-balances';
import type { ImportedSaleEvidenceRpc } from './imported-sale-evidence';
import { ImportedSaleEvidenceError } from './imported-sale-evidence-service';

/** Stops awaiting even an uncooperative transport; the same signal also reaches fetch. */
export async function awaitImportedSaleRead<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abort = () => {};
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        abort = () =>
          reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Server-selected HTTPS endpoint, normal wallet pacing, no retry or signing methods. */
export function createImportedSaleEvidenceRpc(
  endpoint: string,
  fetcher: typeof fetch = fetch,
): ImportedSaleEvidenceRpc {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw Error();
  } catch {
    throw new ImportedSaleEvidenceError(
      'Sale evidence RPC configuration is unavailable.',
      503,
    );
  }
  return async (method, params, signal) => {
    signal.throwIfAborted();
    const valid =
      Array.isArray(params) &&
      ((method === 'getGenesisHash' && params.length === 0) ||
        (method === 'getTransaction' &&
          params.length === 2 &&
          typeof params[0] === 'string' &&
          /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(params[0]) &&
          params[1] !== null &&
          typeof params[1] === 'object' &&
          !Array.isArray(params[1]) &&
          Object.keys(params[1]).sort().join(',') ===
            'commitment,encoding,maxSupportedTransactionVersion' &&
          (params[1] as Record<string, unknown>).commitment === 'finalized' &&
          (params[1] as Record<string, unknown>).encoding === 'base64' &&
          (params[1] as Record<string, unknown>)
            .maxSupportedTransactionVersion === 0));
    if (!valid)
      throw new ImportedSaleEvidenceError(
        'Only finalized sale evidence reads are allowed.',
        400,
      );
    return awaitImportedSaleRead(
      balanceRpc(endpoint, method, params, signal, fetcher, 524288),
      signal,
    );
  };
}
