import { env } from '@/lib/server-env';

const nextReads = new Map<string, number>();
// Public endpoints 429 well below the paid budget, so they get their own floor.
const PUBLIC_HOSTS = new Set([
  'api.mainnet-beta.solana.com',
  'solana-rpc.publicnode.com',
]);
export const PUBLIC_QUALIFICATION_METHOD_BUDGET = 5;
/** Rolling methods/second for explicit qualification. Only the configured stock
 * runtime endpoint may raise it via SOLANA_STOCK_RUNTIME_METHODS_PER_SECOND. */
export function stockQualificationMethodBudget(
  endpoint: string,
  configured = (env as unknown as Record<string, unknown>)
    .SOLANA_STOCK_RUNTIME_METHODS_PER_SECOND,
  runtime = (env as unknown as Record<string, unknown>)
    .SOLANA_STOCK_RUNTIME_RPC_URL,
) {
  const fallbackBudget = () =>
    PUBLIC_HOSTS.has(new URL(endpoint).hostname)
      ? PUBLIC_QUALIFICATION_METHOD_BUDGET
      : 9;
  if (configured === undefined || configured === '') return fallbackBudget();
  if (typeof configured !== 'string' || !/^[1-9]\d?$/.test(configured))
    throw new Error('Invalid stock runtime RPC method budget.');
  return typeof runtime === 'string' &&
    runtime !== '' &&
    new URL(runtime).href === new URL(endpoint).href
    ? Number(configured)
    : fallbackBudget();
}
type Admission = { at: number; units: number };
const qualification = new Map<
  string,
  { tail: Promise<void>; sent: Admission[]; nextRead: number }
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
  qualificationScope?: 'stock-runtime-evidence',
) {
  signal.throwIfAborted();
  const configured = (env as unknown as Record<string, unknown>)
    .SOLANA_RPC_MIN_INTERVAL_MS;
  if (
    (configured === undefined || configured === '') &&
    qualificationMethods === undefined
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
      (new URL(endpoint).hostname !== 'mainnet.helius-rpc.com' &&
        qualificationScope !== 'stock-runtime-evidence') ||
      !Number.isInteger(qualificationMethods) ||
      qualificationMethods < 1 ||
      qualificationMethods > 2
    )
      throw Error('Invalid unsigned qualification pacing profile.');
    if (!qualification.has(endpoint)) {
      if (qualification.size >= 64)
        throw Error('Wallet RPC provider capacity reached.');
      qualification.set(endpoint, {
        tail: Promise.resolve(),
        sent: [],
        nextRead: 0,
      });
    }
  }
  // Qualification is explicit per call. Its admissions and scheduling never
  // mutate the ordinary endpoint queue or enroll unrelated wallet reads.
  const profile =
    qualificationMethods === undefined
      ? undefined
      : qualification.get(endpoint);
  if (profile) {
    // Actual admissions, not scheduled timer targets: delayed timers cannot bunch
    // requests into a burst. Only explicitly opted-in calls share this budget.
    const units = qualificationMethods!;
    const budget =
      qualificationScope === 'stock-runtime-evidence'
        ? stockQualificationMethodBudget(endpoint)
        : 9;
    if (units > budget)
      throw Error(
        'Qualification request exceeds the configured method budget.',
      );
    const pending = profile.tail.then(async () => {
      for (;;) {
        signal.throwIfAborted();
        const now = Date.now();
        // A 25 ms guard: the qualifier measures the same window from the request
        // start, and a boundary-straddling entry otherwise lets a 10th through.
        profile.sent = profile.sent.filter((entry) => entry.at > now - 1025);
        const budgetAt =
          profile.sent.reduce((sum, entry) => sum + entry.units, 0) + units >
          budget
            ? profile.sent[0].at + 1025
            : now;
        const at = Math.max(now, profile.nextRead, budgetAt);
        if (at > now) {
          await waitUntil(at, signal);
          continue;
        }
        profile.sent.push({ at: now, units });
        profile.nextRead =
          now +
          Math.max(
            // 1000/budget is one interval too fast: the window is closed at both
            // ends, so the first admission's units count too. budget-1 intervals
            // is what actually keeps a rolling second at or under the budget.
            Math.ceil(1000 / Math.max(1, budget - 1)) * units,
            interval > 200 ? interval : 0,
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
