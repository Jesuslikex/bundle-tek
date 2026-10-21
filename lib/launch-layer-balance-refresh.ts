import { z } from 'zod';
import type { LaunchLayerEnvelope } from './launch-layer-terms';
import {
  layerRoleMembers,
  layerNativeComparison,
  savedLayerSolObservation,
} from './launch-layer-native-coverage';
import { formatNativeBalance } from './wallet-balance-format';
import { walletAddress } from './wallet-workspace';

// Match the existing balance route without changing its shared owner gate.
export const LAYER_SOL_GROUP_SIZE = 100;
export const LAYER_SOL_GROUP_WAIT_MS = 15000;
type Comparison = ReturnType<typeof layerNativeComparison>;
type Observation = NonNullable<ReturnType<typeof savedLayerSolObservation>>;
export type LayerSolProgress = {
  completed: number;
  total: number;
  group: number;
  groups: number;
  phase: 'checking' | 'reading' | 'retaining' | 'waiting' | 'done' | 'stopped';
};
export class LayerSolRefreshError extends Error {
  constructor(readonly code: 'unconfirmed' | 'changed' | 'limited' | 'access') {
    super(
      code === 'limited'
        ? 'The shared balance refresh limit was reached. Wait before another explicit refresh; no automatic retry.'
        : code === 'access'
          ? 'Sign in again before refreshing saved wallet balances.'
          : code === 'changed'
            ? 'Plan, wallets or retained observations changed. Reload the saved plan or observations before another refresh.'
            : 'Balance refresh could not be confirmed. Load saved observations before another refresh; an in-flight read may have been retained.',
    );
  }
}
export function layerSolRefreshHttpError(status: number) {
  return new LayerSolRefreshError(
    status === 429
      ? 'limited'
      : status === 401 || status === 403
        ? 'access'
        : status === 409 || status === 404
          ? 'changed'
          : 'unconfirmed',
  );
}
export const LAYER_SOL_RESPONSE_BYTES = 1048576;
export async function readLayerSolJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) {
    void response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
  }
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      response.headers.get('content-type') ?? '',
    )
  ) {
    void response.body?.cancel().catch(() => {});
    throw new LayerSolRefreshError('unconfirmed');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new LayerSolRefreshError('unconfirmed');
  let finished = false,
    cancelled = false,
    size = 0,
    text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const cancel = () => {
    if (!cancelled) {
      cancelled = true;
      void reader.cancel().catch(() => {});
    }
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) {
        finished = true;
        break;
      }
      size += next.value.byteLength;
      if (size > LAYER_SOL_RESPONSE_BYTES)
        throw new LayerSolRefreshError('unconfirmed');
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new LayerSolRefreshError('unconfirmed');
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}
export function layerSolRefreshGroups(envelope: LaunchLayerEnvelope) {
  const addresses = layerRoleMembers(envelope).map(
    (row) => row.member.wallet.address,
  );
  if (
    !addresses.length ||
    addresses.length > 500 ||
    new Set(addresses).size !== addresses.length
  )
    throw new LayerSolRefreshError('changed');
  return Array.from(
    { length: Math.ceil(addresses.length / LAYER_SOL_GROUP_SIZE) },
    (_, index) =>
      addresses.slice(
        index * LAYER_SOL_GROUP_SIZE,
        (index + 1) * LAYER_SOL_GROUP_SIZE,
      ),
  );
}
const stamp = z.string().refine((v) => {
  try {
    return new Date(v).toISOString() === v;
  } catch {
    return false;
  }
});
const snapshotSchema = z
  .object({
    chain: z.literal('Solana'),
    items: z.array(z.unknown()).min(1).max(100),
    total: z.string().max(64),
    currency: z.literal('SOL'),
    blockNumber: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    observedAt: stamp,
    snapshotId: z.uuid(),
    source: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[a-zA-Z0-9.:[\]_-]+$/),
    commitment: z.literal('confirmed'),
    blockHash: z.null(),
  })
  .strict();
export function admitLayerSolRefresh(
  value: unknown,
  addresses: readonly string[],
) {
  try {
    const snapshot = snapshotSchema.parse(value);
    if (
      snapshot.items.length !== addresses.length ||
      new Set(addresses).size !== addresses.length
    )
      throw Error();
    if (
      addresses.some((address) => walletAddress(address, 'Solana') !== address)
    )
      throw Error();
    const observations = snapshot.items.map((item, index) => {
      const row = savedLayerSolObservation(
        item,
        addresses[index],
        snapshot.blockNumber,
        snapshot.observedAt,
      );
      if (
        !row ||
        row.snapshotId !== snapshot.snapshotId ||
        row.observedAt !== snapshot.observedAt ||
        row.source !== snapshot.source ||
        row.commitment !== snapshot.commitment
      )
        throw Error();
      return { address: addresses[index], observation: row };
    });
    if (
      snapshot.total !==
      formatNativeBalance(
        observations
          .reduce((sum, row) => sum + BigInt(row.observation.raw), 0n)
          .toString(),
        9,
      )
    )
      throw Error();
    return {
      snapshotId: snapshot.snapshotId,
      blockNumber: snapshot.blockNumber,
      observations,
    };
  } catch {
    throw new LayerSolRefreshError('unconfirmed');
  }
}
function confirmed(comparison: Comparison, expected: Map<string, Observation>) {
  const fields = [
    'raw',
    'observedAt',
    'snapshotId',
    'slot',
    'source',
    'commitment',
  ] as const;
  for (const [address, observation] of expected) {
    const retained = comparison.rows.find(
      (row) => row.address === address,
    )?.observation;
    if (
      !retained ||
      fields.some((field) => retained[field] !== observation[field])
    )
      throw new LayerSolRefreshError('changed');
  }
}
function wait(milliseconds: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}
/** Finite user-requested reads only. No retries, transfers, signing or grants. */
export async function refreshLayerSol({
  plan,
  signal,
  current,
  readEvidence,
  refreshGroup,
  onProgress,
  onComparison,
}: {
  plan: { id: string; sha256: string; envelope: LaunchLayerEnvelope };
  signal: AbortSignal;
  current: () => boolean;
  readEvidence: (signal: AbortSignal) => Promise<unknown>;
  refreshGroup: (addresses: string[], signal: AbortSignal) => Promise<unknown>;
  onProgress: (value: LayerSolProgress) => void;
  onComparison: (value: Comparison) => void;
}) {
  const bound = structuredClone(plan);
  const groups = layerSolRefreshGroups(bound.envelope),
    total = groups.flat().length,
    expected = new Map<string, Observation>();
  const checkpoint = () => {
    signal.throwIfAborted();
    if (!current()) throw new LayerSolRefreshError('changed');
  };
  const progress = (phase: LayerSolProgress['phase'], group: number) => {
    checkpoint();
    onProgress({
      phase,
      group,
      groups: groups.length,
      total,
      completed: expected.size,
    });
    checkpoint();
  };
  let latest: Comparison | undefined;
  for (const [index, addresses] of groups.entries()) {
    if (index) {
      progress('waiting', index + 1);
      await wait(LAYER_SOL_GROUP_WAIT_MS, signal);
      checkpoint();
    }
    progress('checking', index + 1);
    const before = layerNativeComparison(
      await readEvidence(signal),
      bound,
      bound.envelope,
    );
    checkpoint();
    confirmed(before, expected);
    progress('reading', index + 1);
    const receipt = admitLayerSolRefresh(
      await refreshGroup([...addresses], signal),
      addresses,
    );
    checkpoint();
    if (
      before.rows.some(
        (row) => row.observation?.snapshotId === receipt.snapshotId,
      ) ||
      before.rows.some(
        (row) =>
          addresses.includes(row.address) &&
          row.observation &&
          row.observation.slot > receipt.blockNumber,
      )
    )
      throw new LayerSolRefreshError('unconfirmed');
    const pending = new Map(expected);
    for (const row of receipt.observations)
      pending.set(row.address, row.observation);
    progress('retaining', index + 1);
    latest = layerNativeComparison(
      await readEvidence(signal),
      bound,
      bound.envelope,
    );
    checkpoint();
    confirmed(latest, pending);
    for (const row of receipt.observations)
      expected.set(row.address, row.observation);
    onComparison(latest);
    progress(index === groups.length - 1 ? 'done' : 'retaining', index + 1);
  }
  return latest!;
}
