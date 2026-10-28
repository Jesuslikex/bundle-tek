import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import { buildOwnedJitoSignedVector } from './jito-owned-signed-vector';
import { readJitoSimulationPayload } from './jito-simulation-json';
import { PAIR_CLOCK, pairClockUnixTimestamp } from './pair-stock-clock';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import type { JitoBundleManifest } from './jito-bundle';
import { snapshotJitoEvidence } from './jito-evidence-json';

const fail = (): never => {
  throw Error('Jito Clock or lifetime evidence refused.');
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail();
  return value as Record<string, unknown>;
};
const fields = (value: Record<string, unknown>, keys: string[]) => {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return fail();
};
const rpcContext = (value: unknown) => {
  const context = object(value);
  const keys = Object.hasOwn(context, 'apiVersion')
    ? ['slot', 'apiVersion']
    : ['slot'];
  fields(context, keys);
  if (
    Object.hasOwn(context, 'apiVersion') &&
    (typeof context.apiVersion !== 'string' ||
      !/^[A-Za-z0-9.+-]{1,64}$/.test(context.apiVersion))
  )
    return fail();
  return context;
};
const integer = (value: unknown, max = (1n << 64n) - 1n) => {
  if (typeof value !== 'bigint' || value < 0n || value > max) return fail();
  return value;
};
const slot = (value: unknown) => {
  const n = Number(integer(value, BigInt(Number.MAX_SAFE_INTEGER)));
  if (n < 1) return fail();
  return n;
};
type Capture = { request: string; response: Uint8Array };
const own = (value: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
    return fail();
  return descriptor.value;
};
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayField = (
  view: Uint8Array,
  key: 'buffer' | 'byteOffset' | 'byteLength',
) =>
  Object.getOwnPropertyDescriptor(typedArrayPrototype, key)!.get!.call(view) as
    | ArrayBuffer
    | number;
function copyCapture(value: unknown): Capture {
  const entry = object(value);
  fields(entry, ['request', 'response']);
  const request = own(entry, 'request'),
    response = own(entry, 'response');
  if (
    typeof request !== 'string' ||
    request.length < 1 ||
    request.length > 32768 ||
    !(response instanceof Uint8Array)
  )
    return fail();
  const buffer = typedArrayField(response, 'buffer');
  const offset = typedArrayField(response, 'byteOffset'),
    length = typedArrayField(response, 'byteLength');
  if (
    !(buffer instanceof ArrayBuffer) ||
    typeof offset !== 'number' ||
    typeof length !== 'number' ||
    length < 1 ||
    length > 65536
  )
    return fail();
  return { request, response: new Uint8Array(buffer, offset, length).slice() };
}

/** Offline structural replay only. Request/response bytes and floor are caller
 * inputs, not authenticated provider evidence, and grant no operation authority.
 * A future trusted server transport must bind actual dispatched bytes, issued raw
 * captures, original floor, owned state and currentness before considering them. */
export async function inspectJitoClockLifetimeEvidence(
  input: {
    rawSnapshot: unknown;
    ownerId: string;
    responseOwnerScope: string | null;
    projectId: string;
    sessionId: string;
    bundleId: string;
    manifestSha256: string;
    originalMinimumSlot: number;
    latestFloor: number;
    beforeGenesis: Capture;
    clock: Capture;
    height: Capture;
    validity: Capture[];
    finalHeight: Capture;
    afterGenesis: Capture;
  },
  signal: AbortSignal,
) {
  // Reject shared memory and bound every response/count before copying or awaiting.
  const aborted = () => signal.throwIfAborted();
  aborted();
  const source = object(input);
  fields(source, [
    'rawSnapshot',
    'ownerId',
    'responseOwnerScope',
    'projectId',
    'sessionId',
    'bundleId',
    'manifestSha256',
    'originalMinimumSlot',
    'latestFloor',
    'beforeGenesis',
    'clock',
    'height',
    'validity',
    'finalHeight',
    'afterGenesis',
  ]);
  const validity = own(source, 'validity');
  if (
    !Array.isArray(validity) ||
    validity.length < 2 ||
    validity.length > 5 ||
    Reflect.ownKeys(validity).length !== validity.length + 1
  )
    return fail();
  const copiedValidity = Array.from({ length: validity.length }, (_, index) =>
    copyCapture(own(validity, String(index))),
  );
  const rawSnapshot = snapshotJitoEvidence(own(source, 'rawSnapshot'), 1048576);
  const sourceContext = snapshotJitoEvidence(
    {
      ownerId: own(source, 'ownerId'),
      responseOwnerScope: own(source, 'responseOwnerScope'),
      projectId: own(source, 'projectId'),
      sessionId: own(source, 'sessionId'),
      bundleId: own(source, 'bundleId'),
      manifestSha256: own(source, 'manifestSha256'),
      originalMinimumSlot: own(source, 'originalMinimumSlot'),
      latestFloor: own(source, 'latestFloor'),
    },
    16384,
  ) as Pick<
    typeof input,
    | 'ownerId'
    | 'responseOwnerScope'
    | 'projectId'
    | 'sessionId'
    | 'bundleId'
    | 'manifestSha256'
    | 'originalMinimumSlot'
    | 'latestFloor'
  >;
  const detached = {
    ...sourceContext,
    rawSnapshot,
    validity: copiedValidity,
    beforeGenesis: copyCapture(own(source, 'beforeGenesis')),
    clock: copyCapture(own(source, 'clock')),
    height: copyCapture(own(source, 'height')),
    finalHeight: copyCapture(own(source, 'finalHeight')),
    afterGenesis: copyCapture(own(source, 'afterGenesis')),
  };
  if (
    !Number.isSafeInteger(detached.originalMinimumSlot) ||
    detached.originalMinimumSlot < 1 ||
    !Number.isSafeInteger(detached.latestFloor) ||
    detached.latestFloor < detached.originalMinimumSlot ||
    detached.latestFloor - detached.originalMinimumSlot > 32 ||
    !Array.isArray(detached.validity)
  )
    return fail();
  const vector = await buildOwnedJitoSignedVector(detached);
  aborted();
  const raw = object(detached.rawSnapshot),
    bundle = object(raw.bundle),
    manifest = bundle.manifest as JitoBundleManifest;
  if (
    manifest.tip.slot < detached.originalMinimumSlot ||
    manifest.tip.slot > detached.latestFloor
  )
    return fail();
  const blockhashes = vector.packets.map((packet) => {
    const tx = getTransactionDecoder().decode(packet.bytes);
    return String(
      getCompiledTransactionMessageDecoder().decode(tx.messageBytes)
        .lifetimeToken,
    );
  });
  if (detached.validity.length !== blockhashes.length) return fail();
  async function response(
    capture: Capture,
    id: string,
    method: string,
    params: unknown[],
  ) {
    aborted();
    const expected = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    if (
      !capture ||
      typeof capture.request !== 'string' ||
      capture.request !== expected ||
      !(capture.response instanceof Uint8Array) ||
      capture.response.byteLength < 1 ||
      capture.response.byteLength > 65536
    )
      return fail();
    const decoded = await readJitoSimulationPayload(
      new Response(Uint8Array.from(capture.response).buffer).body,
      signal,
      65536,
    );
    aborted();
    const envelope = object(decoded.value);
    fields(envelope, ['jsonrpc', 'id', 'result']);
    if (envelope.jsonrpc !== '2.0' || envelope.id !== id) return fail();
    return envelope.result;
  }
  if (
    (await response(
      detached.beforeGenesis,
      'jito-genesis-before',
      'getGenesisHash',
      [],
    )) !== SOLANA_MAINNET_GENESIS
  )
    return fail();
  const clockReply = object(
    await response(detached.clock, 'jito-clock', 'getMultipleAccounts', [
      [PAIR_CLOCK, PAIR_CLOCK],
      {
        encoding: 'base64',
        commitment: 'confirmed',
        minContextSlot: detached.latestFloor,
      },
    ]),
  );
  fields(clockReply, ['context', 'value']);
  const context = rpcContext(clockReply.context);
  const observed = slot(context.slot);
  if (
    observed < detached.latestFloor ||
    observed - detached.originalMinimumSlot > 32 ||
    !Array.isArray(clockReply.value) ||
    clockReply.value.length !== 2
  )
    return fail();
  const a = object(clockReply.value[0]),
    b = object(clockReply.value[1]);
  for (const value of [a, b]) {
    fields(
      value,
      Object.hasOwn(value, 'space')
        ? ['owner', 'executable', 'data', 'lamports', 'rentEpoch', 'space']
        : ['owner', 'executable', 'data', 'lamports', 'rentEpoch'],
    );
    integer(value.lamports);
    integer(value.rentEpoch);
    if (Object.hasOwn(value, 'space') && integer(value.space) !== 40n)
      return fail();
  }
  if (
    a.owner !== b.owner ||
    a.executable !== b.executable ||
    a.lamports !== b.lamports ||
    a.rentEpoch !== b.rentEpoch ||
    a.space !== b.space ||
    JSON.stringify(a.data) !== JSON.stringify(b.data)
  )
    return fail();
  const clockUnix = pairClockUnixTimestamp(a, observed, Date.now());
  const h = integer(
    await response(detached.height, 'jito-height', 'getBlockHeight', [
      { commitment: 'finalized', minContextSlot: observed },
    ]),
  );
  const last = [
    ...manifest.swaps.map((s) => BigInt(s.lastValidBlockHeight)),
    BigInt(manifest.tip.lastValidBlockHeight),
  ];
  if (last.some((height) => h >= height)) return fail();
  let maximumSlot = observed;
  for (let i = 0; i < blockhashes.length; i++) {
    const result = object(
      await response(
        detached.validity[i],
        `jito-valid:${i}`,
        'isBlockhashValid',
        [
          blockhashes[i],
          { commitment: 'finalized', minContextSlot: maximumSlot },
        ],
      ),
    );
    fields(result, ['context', 'value']);
    const ctx = rpcContext(result.context);
    const s = slot(ctx.slot);
    if (
      result.value !== true ||
      s < maximumSlot ||
      s - detached.originalMinimumSlot > 32
    )
      return fail();
    maximumSlot = Math.max(maximumSlot, s);
  }
  const finalHeight = integer(
    await response(
      detached.finalHeight,
      'jito-height-final',
      'getBlockHeight',
      [{ commitment: 'finalized', minContextSlot: maximumSlot }],
    ),
  );
  if (finalHeight < h || last.some((height) => finalHeight >= height))
    return fail();
  if (
    (await response(
      detached.afterGenesis,
      'jito-genesis-after',
      'getGenesisHash',
      [],
    )) !== SOLANA_MAINNET_GENESIS
  )
    return fail();
  // Re-evaluate the wall clock and expiration after every asynchronous parse.
  pairClockUnixTimestamp(a, observed, Date.now());
  if (
    Date.parse(manifest.expiresAt) <= Date.now() ||
    manifest.swaps.some((s) => Date.parse(s.expiresAt) <= Date.now()) ||
    Date.parse(manifest.tip.expiresAt) <= Date.now()
  )
    return fail();
  aborted();
  return {
    format: 'jito-clock-lifetime-offline-v1' as const,
    vectorFingerprint: vector.fingerprint,
    minimumSlot: detached.originalMinimumSlot,
    clockSlot: observed,
    maximumSlot,
    clockUnixTimestamp: clockUnix,
    blockHeight: finalHeight.toString(),
    sourceAuthenticated: false as const,
    networkVerified: false as const,
    providerQualified: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
    automaticExecutionAllowed: false as const,
  };
}
