import type { HolderIndexPage } from './holder-index';
import { HOLDER_RUN_RESUME_MS } from './holder-index';
import {
  fetchSupplyMonitorJson,
  SupplyMonitorReadError,
} from './supply-monitor-read';
export const HOLDER_READ_MAX_RETRIES = 3;
export type HolderReadRetry = {
  attempt: number;
  delayMs: number;
  reason: string;
  page: number;
};
export type HolderPageQuery = {
  enumeration?: 'das-cursor' | 'program-accounts-v2';
  id: string;
  revision: number;
  runId: string;
  page: number;
};
type HolderPageResponse = {
  id: string;
  revision: number;
  runId: string;
  page: HolderIndexPage;
};
function pause(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, delay);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}
/** This POST commits a holder page idempotently; never use this for financial requests. */
export async function readHolderIndexPageWithRetry(
  query: HolderPageQuery,
  signal: AbortSignal,
  onRetry: (retry: HolderReadRetry) => void = () => {},
  resumeBefore = Date.now() + HOLDER_RUN_RESUME_MS,
): Promise<HolderPageResponse> {
  const body = JSON.stringify(query);
  const deadline = Math.min(resumeBefore, Date.now() + HOLDER_RUN_RESUME_MS);
  if (!Number.isFinite(deadline))
    throw new Error('Holder resume deadline is invalid. Reload saved scans.');
  for (let retry = 0; ; retry++) {
    signal.throwIfAborted();
    if (Date.now() >= deadline)
      throw new Error(
        'Holder resume window expired. Saved pages remain available; start a fresh scan.',
      );
    const timeout = AbortSignal.timeout(30000);
    try {
      const result = await fetchSupplyMonitorJson<HolderPageResponse>(
        '/api/imported-projects/holder-index',
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.any([signal, timeout]),
        },
        'Holder page unavailable. Resume or start a fresh scan.',
      );
      signal.throwIfAborted();
      if (
        result?.id !== query.id ||
        result.revision !== query.revision ||
        result.runId !== query.runId ||
        result.page?.page !== query.page ||
        (query.enumeration !== undefined &&
          result.page?.enumeration !== query.enumeration)
      )
        throw new Error(
          'Holder page response differs from the requested saved run.',
        );
      return result;
    } catch (error) {
      signal.throwIfAborted();
      const transient =
        error instanceof SupplyMonitorReadError && error.retryable;
      const timedOut =
        timeout.aborted &&
        (error === timeout.reason ||
          ((error instanceof Error || error instanceof DOMException) &&
            ['TimeoutError', 'AbortError'].includes(error.name)));
      if ((!transient && !timedOut) || retry >= HOLDER_READ_MAX_RETRIES)
        throw error;
      const base = 2000 * 2 ** retry;
      const delayMs = Math.max(
        Math.ceil(base * (1 + Math.random() * 0.2)),
        transient ? (error.retryAfterMs ?? 0) : 0,
      );
      if (Date.now() + delayMs + 30000 > deadline)
        throw new Error(
          'Retry delay exceeds the holder resume window. Saved pages remain available; start a fresh scan.',
        );
      onRetry({
        attempt: retry + 1,
        delayMs,
        page: query.page,
        reason: timedOut
          ? 'Holder page read timed out.'
          : (error as Error).message,
      });
      await pause(delayMs, signal);
    }
  }
}
