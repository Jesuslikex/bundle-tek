import { walletAddress, walletChain } from './wallet-workspace';
import { nativeUnits, type WarmupHistory } from './wallet-warmup';
import { readBoundedPanelJson } from './read-bounded-panel-json';

export type HistoryResult =
  | { address: string; observation: WarmupHistory; error?: never }
  | { address: string; error: string; observation?: never };

const unavailable = 'Wallet history unavailable. Try checking again.';
export class WarmupHistoryReadError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? 'Sign in to check wallet history.'
        : status === 429
          ? 'Wait at least 15 seconds between wallet reads, then check again. No automatic retry.'
          : status === 409 || status === 404
            ? 'Wallet selection changed or is unavailable. Refresh My wallets and open warmup again.'
            : status === 503
              ? 'Wallet storage is unavailable. Try checking again later.'
              : unavailable,
    );
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(unavailable);
  return value as Record<string, unknown>;
}
function iso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function decimal(value: unknown, maxDigits: number): value is string {
  return (
    typeof value === 'string' &&
    new RegExp(`^(0|[1-9]\\d{0,${maxDigits - 1}})$`).test(value)
  );
}
function selection(
  chain: string,
  addresses: string[],
  revisions: Array<{ address: string; revision: number }>,
) {
  const supportedChain = walletChain(chain);
  if (
    !Array.isArray(addresses) ||
    addresses.length < 1 ||
    addresses.length > 20 ||
    new Set(addresses).size !== addresses.length ||
    !Array.isArray(revisions) ||
    revisions.length !== addresses.length ||
    new Set(revisions.map((r) => r?.address)).size !== addresses.length
  )
    throw new Error(unavailable);
  for (const address of addresses) {
    if (
      walletAddress(address, supportedChain) !== address ||
      !revisions.some(
        (r) =>
          r?.address === address &&
          Number.isSafeInteger(r.revision) &&
          r.revision >= 1 &&
          r.revision <= 1_000_000_000,
      )
    )
      throw new Error(unavailable);
  }
}
/** Admit only complete, ordered observations of the exact requested wallets. */
export function decodeWarmupHistory(
  value: unknown,
  chain: string,
  addresses: string[],
): HistoryResult[] {
  const root = record(value),
    unit = nativeUnits(chain);
  if (
    root.chain !== chain ||
    !Array.isArray(root.results) ||
    root.results.length !== addresses.length
  )
    throw new Error(unavailable);
  return root.results.map((value, index) => {
    const row = record(value);
    if (row.address !== addresses[index]) throw new Error(unavailable);
    if ('error' in row) {
      if ('observation' in row || typeof row.error !== 'string')
        throw new Error(unavailable);
      return {
        address: addresses[index],
        error:
          row.error === 'History check timed out.'
            ? 'History check timed out. Check again when ready.'
            : 'History provider unavailable. No readiness conclusion.',
      };
    }
    const observation = record(row.observation);
    if (
      observation.address !== addresses[index] ||
      observation.chain !== chain ||
      observation.currency !== unit.symbol ||
      !iso(observation.observedAt) ||
      typeof observation.source !== 'string' ||
      observation.source.length > 253 ||
      !/^[a-z\d.:[\]-]+$/i.test(observation.source) ||
      typeof observation.nativeBalance !== 'string' ||
      !new RegExp(`^(0|[1-9]\\d{0,77})(?:\\.\\d{1,${unit.decimals}})?$`).test(
        observation.nativeBalance,
      ) ||
      !decimal(observation.block, chain === 'Solana' ? 16 : 78) ||
      typeof observation.coverage !== 'string' ||
      !observation.coverage.length ||
      observation.coverage.length > 1000
    )
      throw new Error(unavailable);
    const [whole, fraction = ''] = observation.nativeBalance.split('.');
    const atoms =
      BigInt(whole) * 10n ** BigInt(unit.decimals) +
      BigInt(fraction.padEnd(unit.decimals, '0'));
    if (atoms > (chain === 'Solana' ? (1n << 64n) - 1n : (1n << 256n) - 1n))
      throw new Error(unavailable);
    if (chain === 'Solana') {
      if (
        'blockHash' in observation ||
        !Number.isSafeInteger(Number(observation.block)) ||
        observation.outgoingTransactions !== null ||
        !Number.isInteger(observation.sampleCount) ||
        Number(observation.sampleCount) < 0 ||
        Number(observation.sampleCount) > 50 ||
        !Number.isInteger(observation.successfulSampleCount) ||
        Number(observation.successfulSampleCount) < 0 ||
        Number(observation.successfulSampleCount) >
          Number(observation.sampleCount)
      )
        throw new Error(unavailable);
      const oldest = observation.oldestObservedAt,
        latest = observation.latestObservedAt;
      if (
        !(oldest === null && latest === null) &&
        !(
          iso(oldest) &&
          iso(latest) &&
          Date.parse(oldest) <= Date.parse(latest) &&
          Date.parse(latest) <= Date.parse(observation.observedAt) + 60000
        )
      )
        throw new Error(unavailable);
      if (observation.sampleCount === 0 && oldest !== null)
        throw new Error(unavailable);
    } else if (
      BigInt(observation.block) > (1n << 256n) - 1n ||
      !decimal(observation.outgoingTransactions, 78) ||
      BigInt(observation.outgoingTransactions) > (1n << 256n) - 1n ||
      observation.sampleCount !== null ||
      observation.successfulSampleCount !== null ||
      observation.oldestObservedAt !== null ||
      observation.latestObservedAt !== null ||
      typeof observation.blockHash !== 'string' ||
      !/^0x[\da-f]{64}$/i.test(observation.blockHash)
    )
      throw new Error(unavailable);
    return {
      address: addresses[index],
      observation: {
        address: addresses[index],
        chain,
        observedAt: observation.observedAt,
        source: observation.source,
        nativeBalance: observation.nativeBalance,
        currency: unit.symbol,
        block: observation.block,
        ...(chain !== 'Solana'
          ? { blockHash: observation.blockHash as string }
          : {}),
        outgoingTransactions: observation.outgoingTransactions as string | null,
        sampleCount: observation.sampleCount as number | null,
        successfulSampleCount: observation.successfulSampleCount as
          | number
          | null,
        oldestObservedAt: observation.oldestObservedAt as string | null,
        latestObservedAt: observation.latestObservedAt as string | null,
        coverage: observation.coverage,
      },
    };
  });
}
/** Same existing read-only endpoint; never retries or changes provider settings. */
export async function readWarmupHistory(
  chain: string,
  addresses: string[],
  revisions: Array<{ address: string; revision: number }>,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  // Own caller arrays before the first await, including in-place prop edits.
  let ownedAddresses: string[];
  try {
    ownedAddresses = [...addresses];
    selection(
      chain,
      ownedAddresses,
      revisions.map((r) => ({ ...r })),
    );
  } catch {
    throw new WarmupHistoryReadError(409);
  }
  signal.throwIfAborted();
  const response = await fetcher('/api/wallet-workspace/warmup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    redirect: 'error',
    signal,
    body: JSON.stringify({ chain, addresses: ownedAddresses }),
  });
  if (signal.aborted) {
    void response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new WarmupHistoryReadError(response.status);
  }
  const value = await readBoundedPanelJson(response, signal);
  signal.throwIfAborted();
  return decodeWarmupHistory(value, chain, ownedAddresses);
}
