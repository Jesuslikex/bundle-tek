import { getTransactionDecoder } from '@solana/kit';
import {
  buildJitoBundleSimulationRequest,
  type JitoBundleSimulationPacket,
} from './jito-bundle-simulation-frames';
import { readJitoSimulationPayload } from './jito-simulation-json';

export type JitoFeeBatchRequest = Readonly<{
  profile: 'jito-fee-batch-v1';
  body: string;
  sha256: string;
  minimumSlot: number;
  packetCount: number;
}>;
type State = {
  packets: JitoBundleSimulationPacket[];
  ids: string[];
  hashes: string[];
};
type Fee = {
  packet: number;
  messageSha256: string;
  feeLamports: string;
  slot: number;
};
const states = new WeakMap<object, State>();
const reasons = new WeakMap<object, string>();
const fail = (reason: string): never => {
  const error = Error('Jito fee batch: ' + reason + '.');
  reasons.set(error, reason);
  throw error;
};
const authority = {
  signingAllowed: false as const,
  executionAllowed: false as const,
  automaticExecutionAllowed: false as const,
  providerQualified: false as const,
  sourceAuthenticated: false as const,
  signatureVerified: false as const,
  altStateVerified: false as const,
  runtimePrivilegesVerified: false as const,
};
const object = (v: unknown) => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    return fail('object required');
  return v as Record<string, unknown>;
};
function fields(
  v: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) {
  if (
    required.some((k) => !Object.hasOwn(v, k)) ||
    Object.keys(v).some((k) => !required.includes(k) && !optional.includes(k))
  )
    return fail('unknown or missing fee field');
}
function uint(v: unknown, max = (1n << 64n) - 1n) {
  if (typeof v !== 'bigint' || v < 0n || v > max)
    return fail('wire fee integer type or range differs');
  return v;
}
async function sha(bytes: Uint8Array) {
  return Buffer.from(
    await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer),
  ).toString('hex');
}
function clonePacket(
  p: JitoBundleSimulationPacket,
): JitoBundleSimulationPacket {
  return {
    ...p,
    loadedAddresses: p.loadedAddresses
      ? {
          writable: [...p.loadedAddresses.writable],
          readonly: [...p.loadedAddresses.readonly],
        }
      : null,
  };
}

/** Immutable request plan only; no transport or approval. Template expected fees
 * undergo structural checks but are NEVER treated as a new bank observation.
 * Existing owned review policy still governs any later signing/fee change. */
export async function buildJitoFeeBatchRequest(input: {
  packets: JitoBundleSimulationPacket[];
  minimumSlot: number;
  idPrefix: string;
}): Promise<JitoFeeBatchRequest> {
  const read = <K extends keyof typeof input>(key: K): (typeof input)[K] => {
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (!d || !Object.hasOwn(d, 'value'))
      return fail('fee request data property required');
    return d.value as (typeof input)[K];
  };
  const minimumSlot = read('minimumSlot'),
    idPrefix = read('idPrefix');
  if (
    !Number.isSafeInteger(minimumSlot) ||
    minimumSlot < 0 ||
    typeof idPrefix !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,96}$/.test(idPrefix)
  )
    return fail('invalid fee request floor or identity');
  // Reuse existing canonical packet/privilege/lookup validation. This simulation
  // request is NOT sent and the template's expected-fee scalar proves no source.
  const prepared = await buildJitoBundleSimulationRequest(
    read('packets'),
    minimumSlot,
    { bankEncoding: 'slot-object', verifySignatures: false },
  );
  const packets = prepared.packetBindings.map(clonePacket),
    ids: string[] = [],
    hashes: string[] = [];
  const requests = [];
  for (let i = 0; i < packets.length; i++) {
    const tx = getTransactionDecoder().decode(
      Buffer.from(packets[i].transaction, 'base64'),
    );
    const bytes = Uint8Array.from(tx.messageBytes),
      id = idPrefix + ':' + i;
    ids.push(id);
    hashes.push(await sha(bytes));
    requests.push({
      jsonrpc: '2.0',
      id,
      method: 'getFeeForMessage',
      params: [
        Buffer.from(bytes).toString('base64'),
        { commitment: 'confirmed', minContextSlot: minimumSlot },
      ],
    });
  }
  const body = JSON.stringify(requests);
  if (new TextEncoder().encode(body).length > 16384)
    return fail('fee request byte bound');
  const plan: JitoFeeBatchRequest = Object.freeze({
    profile: 'jito-fee-batch-v1' as const,
    body,
    sha256: await sha(new TextEncoder().encode(body)),
    minimumSlot,
    packetCount: packets.length,
  });
  states.set(plan, { packets, ids, hashes });
  return plan;
}

/** Strict ordered batch profile (stricter than general JSON-RPC). A batch is NOT
 * an atomic bank read: every actual reply context must agree. There is no retry,
 * provider selection or single-request fallback. Invalid/unrecognized plan or
 * pre-read signal refusal throws without acquiring the caller's body. Captures
 * are private mutable evidence, not public DTOs or immutable owner storage. */
export async function readJitoFeeBatchResponse(
  plan: JitoFeeBatchRequest,
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
) {
  const state = states.get(plan);
  if (!state) return fail('unrecognized fee request plan');
  const aborted = () =>
    Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      'aborted',
    )!.get!.call(signal) as boolean;
  try {
    if (aborted()) return fail('fee read interrupted');
  } catch {
    return fail('fee read interrupted or signal invalid');
  }
  const fees: Fee[] = [];
  let capture: Awaited<ReturnType<typeof readJitoSimulationPayload>>;
  try {
    capture = await readJitoSimulationPayload(body, signal, 32768);
  } catch {
    return {
      status: 'refused' as const,
      reason: 'fee response unavailable',
      rawResponse: null,
      plan,
      fees,
      ...authority,
    };
  }
  const refused = (reason: string) => ({
    status: 'refused' as const,
    reason,
    rawResponse: capture,
    plan,
    fees,
    ...authority,
  });
  try {
    const replies = capture.value;
    if (!Array.isArray(replies) || replies.length !== state.packets.length)
      return fail('fee batch reply count differs');
    for (let i = 0; i < replies.length; i++) {
      const reply = object(replies[i]);
      fields(reply, ['jsonrpc', 'id'], ['result', 'error']);
      if (
        reply.jsonrpc !== '2.0' ||
        reply.id !== state.ids[i] ||
        Object.hasOwn(reply, 'result') === Object.hasOwn(reply, 'error')
      )
        return fail('fee batch reply mapping differs');
      if (Object.hasOwn(reply, 'error')) {
        const error = object(reply.error);
        fields(error, ['code', 'message'], ['data']);
        if (
          typeof error.code !== 'bigint' ||
          error.code < -2147483648n ||
          error.code > 2147483647n ||
          typeof error.message !== 'string' ||
          error.message.length > 4096
        )
          return fail('fee RPC error shape differs');
        return refused('fee RPC refusal');
      }
      const result = object(reply.result);
      fields(result, ['context', 'value']);
      const context = object(result.context);
      fields(context, ['slot'], ['apiVersion']);
      if (
        context.apiVersion !== undefined &&
        (typeof context.apiVersion !== 'string' ||
          !/^[A-Za-z0-9.+-]{1,64}$/.test(context.apiVersion))
      )
        return fail('fee context metadata differs');
      const slot = Number(uint(context.slot, BigInt(Number.MAX_SAFE_INTEGER))),
        value = uint(result.value);
      if (slot < plan.minimumSlot || slot - plan.minimumSlot > 32)
        return fail('fee bank outside floor span');
      if (value < 1n || value > BigInt(state.packets[i].maximumFeeLamports))
        return fail('observed fee outside original cap');
      fees.push({
        packet: i,
        messageSha256: state.hashes[i],
        feeLamports: value.toString(),
        slot,
      });
    }
    if (fees.some((f) => f.slot !== fees[0].slot))
      return refused('fee banks differ');
    if (aborted()) return refused('fee read interrupted');
    const packets = state.packets.map((p, i) => ({
      ...clonePacket(p),
      expectedFeeLamports: fees[i].feeLamports,
    }));
    return {
      status: 'observed' as const,
      simulationBankSlot: fees[0].slot,
      feeBankCoherent: true as const,
      fees,
      packets,
      plan,
      rawResponse: capture,
      ...authority,
    };
  } catch (error) {
    return refused(
      error && typeof error === 'object'
        ? (reasons.get(error) ?? 'fee schema unavailable')
        : 'fee schema unavailable',
    );
  }
}
