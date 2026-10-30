import bs58 from 'bs58';
import { inspectJitoCpmmUnsignedPacket } from './jito-cpmm-unsigned-packet';
import { snapshotJitoEvidence, awaitJitoEvidence } from './jito-evidence-json';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import type { PumpLaunchRpc } from './pump-launch-simulation';
const MARGIN = 10n;
const flags = {
  providerQualified: false as const,
  bankVerified: false as const,
  signingAllowed: false as const,
  executionAllowed: false as const,
};
type Lifetime = {
  blockhash: string;
  lastValidBlockHeight: string;
  minimumSlot: number;
  slot: number;
  providerQualified: false;
  bankVerified: false;
  signingAllowed: false;
  executionAllowed: false;
};
const issued = new WeakMap<
  Lifetime,
  { snapshot: Lifetime; rpc: PumpLaunchRpc }
>();
const fail = (): never => {
  throw Error('CPMM captured lifetime refused.');
};
/** Dependency/original-floor binding only. Not a provider or bank attestation. */
export function requireJitoCpmmLifetimeScope(
  capture: Lifetime,
  rpc: PumpLaunchRpc,
  minimumSlot: number,
) {
  const owned = issued.get(capture);
  if (
    !owned ||
    owned.rpc !== rpc ||
    owned.snapshot.minimumSlot !== minimumSlot ||
    JSON.stringify(snapshotJitoEvidence(capture)) !==
      JSON.stringify(owned.snapshot)
  )
    return fail();
  return snapshotJitoEvidence(owned.snapshot);
}
function uint(value: unknown) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value))
    return fail();
  const n = BigInt(value);
  if (n > (1n << 64n) - 1n) return fail();
  return n;
}
function slot(value: unknown, floor: number, initial: number) {
  const n = Number(uint(value));
  if (!Number.isSafeInteger(n) || n < floor || n - initial > 32) return fail();
  return n;
}
async function read(
  rpc: PumpLaunchRpc,
  method: string,
  params: unknown[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const result = await awaitJitoEvidence(
    signal,
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return rpc(method, params, signal);
    }),
  );
  signal.throwIfAborted();
  return snapshotJitoEvidence(result, 4096);
}
/** Capture before constructing a new unsigned packet. Never replaces a packet's hash. */
export async function captureJitoCpmmLifetime(
  minimumSlot: number,
  rpc: PumpLaunchRpc,
  signal: AbortSignal,
): Promise<Lifetime> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  if (!Number.isSafeInteger(minimumSlot) || minimumSlot < 1) return fail();
  if (
    (await read(rpc, 'getGenesisHash', [], signal)) !== SOLANA_MAINNET_GENESIS
  )
    return fail();
  const latest = (await read(
    rpc,
    'getLatestBlockhash',
    [{ commitment: 'confirmed', minContextSlot: minimumSlot }],
    signal,
  )) as {
    context?: { slot?: unknown };
    value?: { blockhash?: unknown; lastValidBlockHeight?: unknown };
  };
  const at = slot(latest.context?.slot, minimumSlot, minimumSlot),
    hash = latest.value?.blockhash;
  if (typeof hash !== 'string' || hash.length < 32 || hash.length > 44)
    return fail();
  const bytes = bs58.decode(hash);
  if (bytes.length !== 32 || bs58.encode(bytes) !== hash) return fail();
  const last = uint(latest.value?.lastValidBlockHeight);
  if (last < MARGIN) return fail();
  const value = {
    blockhash: hash,
    lastValidBlockHeight: last.toString(),
    minimumSlot,
    slot: at,
    ...flags,
  };
  issued.set(value, { snapshot: snapshotJitoEvidence(value), rpc });
  return value;
}
/** Rechecks only an issued immutable capture on its original RPC dependency. */
export async function recheckJitoCpmmLifetime(
  packet: Parameters<typeof inspectJitoCpmmUnsignedPacket>[0],
  capture: Lifetime,
  minimumReadSlot: number,
  signal: AbortSignal,
) {
  signal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  const owned = issued.get(capture);
  if (
    !owned ||
    JSON.stringify(snapshotJitoEvidence(capture)) !==
      JSON.stringify(owned.snapshot)
  )
    return fail();
  const original = owned.snapshot;
  if (
    !Number.isSafeInteger(minimumReadSlot) ||
    minimumReadSlot < original.slot ||
    minimumReadSlot - original.minimumSlot > 32
  )
    return fail();
  const bound = await inspectJitoCpmmUnsignedPacket(packet);
  signal.throwIfAborted();
  if (bound.blockhash !== original.blockhash) return fail();
  const validity = (await read(
    owned.rpc,
    'isBlockhashValid',
    [
      original.blockhash,
      { commitment: 'confirmed', minContextSlot: minimumReadSlot },
    ],
    signal,
  )) as { context?: { slot?: unknown }; value?: unknown };
  const at = slot(
    validity.context?.slot,
    minimumReadSlot,
    original.minimumSlot,
  );
  if (validity.value !== true) return fail();
  const height = uint(
    await read(
      owned.rpc,
      'getBlockHeight',
      [{ commitment: 'confirmed', minContextSlot: at }],
      signal,
    ),
  );
  if (height + MARGIN > BigInt(original.lastValidBlockHeight)) return fail();
  if (
    (await read(owned.rpc, 'getGenesisHash', [], signal)) !==
    SOLANA_MAINNET_GENESIS
  )
    return fail();
  return {
    format: 'jito-cpmm-lifetime-observation-v1' as const,
    transactionSha256: bound.transactionSha256,
    blockhash: original.blockhash,
    lastValidBlockHeight: original.lastValidBlockHeight,
    blockHeight: height.toString(),
    minimumSlot: original.minimumSlot,
    validitySlot: at,
    remainingBlocks: (
      BigInt(original.lastValidBlockHeight) - height
    ).toString(),
    ...flags,
  };
}
