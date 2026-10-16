import { env } from '@/lib/server-env';

const nextReads = new Map<string, number>();
type Admission = { at: number; units: number };
const qualification = new Map<
  string,
  { tail: Promise<void>; sent: Admission[] }
>();
async function waitUntil(at: number, signal: AbortSignal) {
  signal.throwIfAborted();
  if (at <= Date.now()) return;
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, at - Date.now());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  signal.throwIfAborted();
}
// Optional per-runtime pacing for a configured low-rate provider. No retries or rotation.
export async function paceWalletRpc(
  endpoint: string,
  signal: AbortSignal,
  qualificationMethods?: number,
) {
  signal.throwIfAborted();
  const configured = (env as unknown as Record<string, unknown>)
    .SOLANA_RPC_MIN_INTERVAL_MS;
  if (
    (configured === undefined || configured === '') &&
    qualificationMethods === undefined &&
    !qualification.has(endpoint)
  )
    return;
  if (
    configured !== undefined &&
    configured !== '' &&
    (typeof configured !== 'string' ||
      !/^\d{1,4}$/.test(configured) ||
      Number(configured) > 2000)
  )
    throw new Error('Invalid wallet RPC pacing configuration.');
  const interval = Number(configured ?? 0);
  if (qualificationMethods !== undefined) {
    if (
      new URL(endpoint).hostname !== 'mainnet.helius-rpc.com' ||
      !Number.isInteger(qualificationMethods) ||
      qualificationMethods < 1 ||
      qualificationMethods > 2
    )
      throw Error('Invalid unsigned qualification pacing profile.');
    if (!qualification.has(endpoint)) {
      if (qualification.size >= 64)
        throw Error('Wallet RPC provider capacity reached.');
      qualification.set(endpoint, { tail: Promise.resolve(), sent: [] });
    }
  }
  const profile = qualification.get(endpoint);
  if (profile) {
    // Actual admissions, not scheduled timer targets: delayed timers cannot bunch
    // requests into a burst. Mixed ordinary callers count conservatively as two.
    const units = qualificationMethods ?? 2;
    const pending = profile.tail.then(async () => {
      for (;;) {
        signal.throwIfAborted();
        const now = Date.now();
        profile.sent = profile.sent.filter((entry) => entry.at > now - 1000);
        const budgetAt =
          profile.sent.reduce((sum, entry) => sum + entry.units, 0) + units > 9
            ? profile.sent[0].at + 1000
            : now;
        const at = Math.max(now, nextReads.get(endpoint) ?? now, budgetAt);
        if (at > now) {
          await waitUntil(at, signal);
          continue;
        }
        profile.sent.push({ at: now, units });
        nextReads.set(
          endpoint,
          now +
            (qualificationMethods === undefined
              ? interval
              : Math.max(112 * units, interval > 200 ? interval : 0)),
        );
        return;
      }
    });
    profile.tail = pending.catch(() => {});
    await pending;
    return;
  }
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
