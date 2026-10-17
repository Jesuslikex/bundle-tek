import { isIP } from 'node:net';
import { env } from './server-env';
import {
  selectMarketplaceInventory,
  type MarketplaceFilters,
} from './marketplace-catalog';

export class MarketplaceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function readMarketplaceCatalog(
  filters: MarketplaceFilters,
  signal: AbortSignal,
  options: {
    configuration?: Record<string, string | undefined>;
    transport?: typeof fetch;
    now?: () => number;
  } = {},
) {
  const config = options.configuration ?? env;
  const endpoint = config.MARKETPLACE_CATALOG_URL;
  if (!endpoint)
    throw new MarketplaceError(
      'No wallet inventory provider is connected. Purchases are unavailable.',
      503,
    );
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.port ||
      isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
      !url.hostname.includes('.') ||
      /(^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname)
    )
      throw new Error();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
    const response = await (options.transport ?? fetch)(url, {
      method: 'GET',
      signal: requestSignal,
      redirect: 'error',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        ...(config.MARKETPLACE_CATALOG_TOKEN
          ? { authorization: `Bearer ${config.MARKETPLACE_CATALOG_TOKEN}` }
          : {}),
      },
    });
    if (response.status === 429)
      throw new MarketplaceError(
        'Inventory provider is rate limited. Try again later.',
        429,
      );
    if (
      !response.ok ||
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers.get('content-type') ?? '',
      )
    )
      throw new Error();
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    let size = 0,
      text = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    requestSignal.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        requestSignal.throwIfAborted();
        const chunk = await reader.read();
        requestSignal.throwIfAborted();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 262144) throw new Error();
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      requestSignal.removeEventListener('abort', abort);
      void reader.cancel().catch(() => {});
    }
    return selectMarketplaceInventory(
      JSON.parse(text),
      filters,
      (options.now ?? Date.now)(),
    );
  } catch (error) {
    if (error instanceof MarketplaceError) throw error;
    throw new MarketplaceError(
      'Inventory could not be verified. Refresh later; checkout remains unavailable.',
      502,
    );
  }
}
