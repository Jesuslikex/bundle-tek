import { env } from 'cloudflare:workers';

const nextReads = new Map<string, number>();
// Optional per-runtime pacing for a configured low-rate provider. No retries or rotation.
export async function paceWalletRpc(endpoint: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const configured = (env as unknown as Record<string, unknown>)
    .SOLANA_RPC_MIN_INTERVAL_MS;
  if (configured === undefined || configured === '') return;
  if (
    typeof configured !== 'string' ||
    !/^\d{1,4}$/.test(configured) ||
    Number(configured) > 2000
  )
    throw new Error('Invalid wallet RPC pacing configuration.');
  const interval = Number(configured);
  if (interval === 0) return;
  if (!nextReads.has(endpoint) && nextReads.size >= 64)
    throw new Error('Wallet RPC provider capacity reached.');
  const now = Date.now(),
    start = Math.max(now, nextReads.get(endpoint) ?? now);
  nextReads.set(endpoint, start + interval);
  if (start > now)
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, start - now);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  signal.throwIfAborted();
}
