import type { MarketFeedReadResult } from './foreground-market-feed';

const overlap =
  'Supply sample differs or overlaps the previous observation. Retry later.';

export class SupplyMonitorReadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'SupplyMonitorReadError';
  }
}

export function supplyMonitorRetryAfter(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value?.trim()) return undefined;
  const raw = value.trim();
  const delay = /^\d+(\.\d+)?$/.test(raw)
    ? Number(raw) * 1000
    : Date.parse(raw) - now;
  return Number.isFinite(delay) && delay > 0
    ? Math.min(delay, 86400000)
    : undefined;
}

// Only the sample-overlap 409 is transient. Other 409s require user review.
export function supplyMonitorHttpError(
  status: number,
  message: string,
  retryAfter: string | null,
  method: string,
): SupplyMonitorReadError {
  return new SupplyMonitorReadError(
    message,
    status === 429 ||
      [500, 502, 503, 504].includes(status) ||
      (method === 'POST' && status === 409 && message === overlap),
    supplyMonitorRetryAfter(retryAfter),
  );
}

export function supplyMonitorFailure(error: unknown): MarketFeedReadResult {
  return error instanceof SupplyMonitorReadError && error.retryable
    ? {
        status: 'retry',
        reason: error.message,
        retryAfterMs: error.retryAfterMs,
      }
    : false;
}

export async function fetchSupplyMonitorJson<T>(
  input: string | URL,
  init: RequestInit,
  fallback: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new SupplyMonitorReadError(
      'Supply monitor network read unavailable.',
      true,
    );
  }
  if (!response.ok) {
    let message = fallback;
    try {
      const data = (await response.json()) as { error?: unknown } | null;
      if (typeof data?.error === 'string') message = data.error;
    } catch {
      /* Upstream errors may have a non-JSON body. */
    }
    throw supplyMonitorHttpError(
      response.status,
      message,
      response.headers.get('retry-after'),
      init.method ?? 'GET',
    );
  }
  // Malformed successful responses are not retried as network failures.
  return (await response.json()) as T;
}
