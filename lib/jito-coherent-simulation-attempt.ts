import {
  buildJitoFeeBatchRequest,
  readJitoFeeBatchResponse,
} from './jito-fee-batch';
import { buildJitoBundleSimulationRequest } from './jito-bundle-simulation-frames';
import type { JitoBundleSimulationPacket } from './jito-bundle-simulation-frames';
import { readJitoSimulationResponse } from './jito-simulation-response';
import { readJitoSimulationPayload } from './jito-simulation-json';
import { readJitoRpcBatchCapture } from './jito-rpc-batch-capture';

export type JitoCoherentSimulationRead = Readonly<{
  phase: 'discovery' | 'batch';
  methodCount: number;
  body: string;
  signal: AbortSignal;
}>;
export type JitoCoherentSimulationTransport = (
  request: JitoCoherentSimulationRead,
) => Promise<Response>;
type Phase = JitoCoherentSimulationRead['phase'];
type HttpRead = {
  phase: Phase;
  status: number | null;
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
  economicOutputVerified: false as const,
};
// Conservative stop signal only: malformed/unmatched RPC429 never admits evidence.
const rateLimited = (value: unknown): boolean => {
  const envelope = (v: unknown) =>
    v !== null &&
    typeof v === 'object' &&
    (v as { error?: { code?: unknown } }).error?.code === 429n;
  return Array.isArray(value) ? value.some(envelope) : envelope(value);
};
const interrupted = (signal: AbortSignal): boolean =>
  Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!.call(
    signal,
  ) as boolean;
const responseField = <K extends 'status' | 'body'>(
  response: Response,
  key: K,
): Response[K] =>
  Object.getOwnPropertyDescriptor(Response.prototype, key)!.get!.call(
    response,
  ) as Response[K];
function cancel(response: Response) {
  try {
    void responseField(response, 'body')
      ?.cancel()
      .catch(() => {});
  } catch {
    // An invalid transport result grants no evidence or authority.
  }
}

/** Internal read-only orchestration, with no provider settings, retry or fallback.
 * Discovery is an unadmitted hint; only the second mixed batch supplies fee/frame evidence.
 * The supplied trusted server transport receives at most two read bodies.
 * This does not authenticate its endpoint or prove bytes sent over the network.
 * Raw bodies/packets are private mutable evidence, never a public response DTO.
 * Neither successful frame replay nor this collector grants signing authority. */
export async function collectJitoCoherentSimulationAttempt(input: {
  packets: JitoBundleSimulationPacket[];
  minimumSlot: number;
  feeIdPrefix: string;
  simulationRpcId: string;
  minimumReadSlot: number;
  verifySignatures: boolean;
  signal: AbortSignal;
  transport: JitoCoherentSimulationTransport;
}) {
  const read = <K extends keyof typeof input>(key: K): (typeof input)[K] => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value'))
      throw Error('Jito simulation attempt data property required.');
    return descriptor.value as (typeof input)[K];
  };
  const minimumSlot = read('minimumSlot'),
    feeIdPrefix = read('feeIdPrefix'),
    simulationRpcId = read('simulationRpcId'),
    minimumReadSlot = read('minimumReadSlot'),
    verifySignatures = read('verifySignatures'),
    signal = read('signal'),
    transport = read('transport');
  if (
    !Number.isSafeInteger(minimumSlot) ||
    minimumSlot < 0 ||
    typeof simulationRpcId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(simulationRpcId) ||
    !Number.isSafeInteger(minimumReadSlot) ||
    minimumReadSlot < minimumSlot ||
    minimumReadSlot - minimumSlot > 32 ||
    typeof verifySignatures !== 'boolean' ||
    typeof transport !== 'function' ||
    interrupted(signal)
  )
    throw Error('Jito simulation attempt policy or signal differs.');
  // The factory snapshots packet bindings before awaiting; full canonical
  // validation completes before it returns the immutable plan.
  const packetPromise = buildJitoBundleSimulationRequest(
    read('packets'),
    minimumSlot,
    {
      bankEncoding: 'slot-object',
      verifySignatures,
    },
  );
  const owner = new AbortController();
  const timeout = AbortSignal.timeout(30000);
  const deadline = AbortSignal.any([signal, owner.signal, timeout]);
  const reads: HttpRead[] = [];
  const responses: Response[] = [];
  let phase: Phase = 'discovery';
  let planReady = false;
  let fees: Awaited<ReturnType<typeof readJitoFeeBatchResponse>> | null = null;
  let simulation: Awaited<
    ReturnType<typeof readJitoSimulationResponse>
  > | null = null;
  let discovery: Awaited<ReturnType<typeof readJitoSimulationPayload>> | null =
    null;
  let batch: Awaited<ReturnType<typeof readJitoRpcBatchCapture>> | null = null;
  let feeProjection: {
    kind: 'derived-member-array-not-wire';
    rawBody: Uint8Array;
  } | null = null;
  let discoveryBody: string | null = null;
  let batchBody: string | null = null;
  let sentSimulationBody: string | null = null;
  const refuse = (
    reason:
      | 'interrupted'
      | 'transport-unavailable'
      | 'plan-refused'
      | 'rate-limited'
      | 'http-refused'
      | 'fees-refused'
      | 'simulation-refused'
      | 'bank-unavailable'
      | 'request-binding-differs',
  ) => ({
    status: 'refused' as const,
    phase,
    reason,
    minimumSlot,
    reads,
    fees,
    simulation,
    sentSimulationBody,
    discovery,
    batch,
    discoveryBody,
    batchBody,
    feeProjection,
    ...authority,
  });
  async function send(body: string, methodCount: number) {
    deadline.throwIfAborted();
    const record: HttpRead = { phase, status: null };
    reads.push(record);
    const request = Object.freeze({
      phase,
      body,
      signal: deadline,
      methodCount,
    });
    // Observe a late response even if the owner has already returned on abort.
    const pending = Promise.resolve().then(async () => {
      deadline.throwIfAborted();
      const response = await transport(request);
      // Own it before promise adoption can race an abort. A late response is
      // cancelled directly below even if terminal cleanup already ran.
      responses.push(response);
      if (deadline.aborted) {
        cancel(response);
        throw Error('Jito simulation attempt interrupted.');
      }
      return response;
    });
    let onAbort: () => void = () => {};
    const abort = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(Error('Jito simulation attempt interrupted.'));
      deadline.addEventListener('abort', onAbort, { once: true });
      if (deadline.aborted) onAbort();
    });
    try {
      const response = await Promise.race([pending, abort]);
      record.status = responseField(response, 'status');
      if (record.status < 200 || record.status >= 300) {
        cancel(response);
        return null;
      }
      return response;
    } finally {
      deadline.removeEventListener('abort', onAbort);
    }
  }
  try {
    const prepared = await packetPromise;
    // Validate the fee identity before the first transport read, too.
    await buildJitoFeeBatchRequest({
      packets: prepared.packetBindings,
      minimumSlot,
      idPrefix: feeIdPrefix,
    });
    planReady = true;
    deadline.throwIfAborted();
    const discoveryId = `${simulationRpcId}:discovery`;
    if (discoveryId.length > 128) return refuse('plan-refused');
    const discoveryParams = structuredClone(prepared.params) as unknown as [
      unknown,
      Record<string, unknown>,
    ];
    discoveryParams[1].simulationBank = {
      commitment: { commitment: 'confirmed' },
    };
    discoveryBody = JSON.stringify({
      jsonrpc: '2.0',
      id: discoveryId,
      method: prepared.method,
      params: discoveryParams,
    });
    const first = await send(discoveryBody, 1);
    if (!first)
      return {
        ...refuse(
          reads.at(-1)?.status === 429 ? 'rate-limited' : 'http-refused',
        ),
        detail: 'status ' + String(reads.at(-1)?.status ?? 'none'),
      };
    discovery = await readJitoSimulationPayload(
      responseField(first, 'body'),
      deadline,
      4194304,
      { allowDecimalTokens: true },
    );
    if (rateLimited(discovery.value)) return refuse('rate-limited');
    const object = (v: unknown): Record<string, unknown> => {
      if (!v || typeof v !== 'object' || Array.isArray(v))
        throw Error('discovery');
      return v as Record<string, unknown>;
    };
    const exact = (v: Record<string, unknown>, keys: string[]) => {
      if (
        Object.keys(v).length !== keys.length ||
        keys.some((k) => !Object.hasOwn(v, k))
      )
        throw Error('discovery');
    };
    const envelope = object(discovery.value);
    exact(envelope, ['jsonrpc', 'id', 'result']);
    if (envelope.jsonrpc !== '2.0' || envelope.id !== discoveryId)
      return refuse('simulation-refused');
    const result = object(envelope.result);
    exact(result, ['context', 'value']);
    const context = object(result.context),
      value = object(result.value);
    exact(
      context,
      Object.hasOwn(context, 'apiVersion') ? ['slot', 'apiVersion'] : ['slot'],
    );
    if (
      context.apiVersion !== undefined &&
      (typeof context.apiVersion !== 'string' ||
        !/^[A-Za-z0-9.+-]{1,64}$/.test(context.apiVersion))
    )
      return refuse('simulation-refused');
    exact(value, ['summary', 'transactionResults']);
    if (
      typeof context.slot !== 'bigint' ||
      context.slot < BigInt(minimumReadSlot) ||
      context.slot > BigInt(minimumSlot) + 32n ||
      value.summary !== 'succeeded' ||
      !Array.isArray(value.transactionResults) ||
      value.transactionResults.length !== prepared.packetBindings.length ||
      value.transactionResults.some((v) => object(v).err !== null)
    )
      return refuse('simulation-refused');
    const bank = Number(context.slot);
    const plan = await buildJitoFeeBatchRequest({
      packets: prepared.packetBindings,
      minimumSlot: bank,
      idPrefix: feeIdPrefix,
    });
    const request = await buildJitoBundleSimulationRequest(
      prepared.packetBindings,
      bank,
      { bankEncoding: 'slot-object', verifySignatures },
    );
    sentSimulationBody = JSON.stringify({
      jsonrpc: '2.0',
      id: simulationRpcId,
      method: request.method,
      params: request.params,
    });
    batchBody = plan.body.slice(0, -1) + ',' + sentSimulationBody + ']';
    if (new TextEncoder().encode(batchBody).byteLength > 32768)
      return refuse('plan-refused');
    phase = 'batch';
    const response = await send(batchBody, prepared.packetBindings.length + 1);
    if (!response)
      return {
        ...refuse(
          reads.at(-1)?.status === 429 ? 'rate-limited' : 'http-refused',
        ),
        detail: 'status ' + String(reads.at(-1)?.status ?? 'none'),
      };
    const ids = Array.from(
      { length: prepared.packetBindings.length },
      (_, i) => `${feeIdPrefix}:${i}`,
    );
    batch = await readJitoRpcBatchCapture(
      responseField(response, 'body'),
      deadline,
      [...ids, simulationRpcId],
    );
    if (rateLimited(batch.rawResponse?.value)) return refuse('rate-limited');
    if (batch.status !== 'captured') return refuse('simulation-refused');
    const bytes = batch.members.slice(0, -1).map((m) => m.rawBody);
    const derived = new Uint8Array(
      2 + bytes.reduce((n, b) => n + b.byteLength, 0) + bytes.length - 1,
    );
    let offset = 0;
    derived[offset++] = 91;
    for (const [i, b] of bytes.entries()) {
      if (i) derived[offset++] = 44;
      derived.set(b, offset);
      offset += b.byteLength;
    }
    derived[offset] = 93;
    feeProjection = { kind: 'derived-member-array-not-wire', rawBody: derived };
    fees = await readJitoFeeBatchResponse(
      plan,
      new Response(derived).body,
      deadline,
    );
    if (fees.status !== 'observed' || fees.simulationBankSlot !== bank)
      return refuse('fees-refused');
    simulation = await readJitoSimulationResponse({
      profile: 'jito-rust-raw-frames-v1',
      packets: fees.packets,
      minimumSlot,
      simulationBankSlot: bank,
      bankEncoding: 'slot-object',
      verifySignatures,
      rpcId: simulationRpcId,
      body: new Response(Uint8Array.from(batch.members.at(-1)!.rawBody).buffer)
        .body,
      signal: deadline,
    });
    deadline.throwIfAborted();
    if (simulation.request.body !== sentSimulationBody)
      return refuse('request-binding-differs');
    if (simulation.status !== 'admitted') {
      // Only the reason is safe fixed text. The attached raw capture remains
      // private evidence and MUST NOT be published as a public response DTO.
      const error = simulation.rawResponse?.value as
        | { error?: { code?: unknown; message?: unknown } }
        | undefined;
      const unavailable =
        simulation.reason === 'provider RPC refusal' &&
        error?.error?.code === -32602n &&
        error.error.message ===
          `bank not found for the provided slot: ${fees.simulationBankSlot}`;
      return refuse(unavailable ? 'bank-unavailable' : 'simulation-refused');
    }
    return {
      status: 'captured' as const,
      minimumSlot,
      reads,
      fees,
      simulation,
      sentSimulationBody,
      discovery,
      batch,
      discoveryBody,
      batchBody,
      feeProjection,
      ...authority,
    };
  } catch (error) {
    // The reason alone says nothing about which step threw; keep the message.
    // These are our own refusal strings, not provider bodies.
    const detail =
      error instanceof Error ? error.message.slice(0, 300) : 'unknown';
    return {
      ...refuse(
        deadline.aborted
          ? 'interrupted'
          : planReady
            ? 'transport-unavailable'
            : 'plan-refused',
      ),
      detail,
    };
  } finally {
    owner.abort();
    // Readers normally drain/cancel their own acquired bodies. Also close a
    // returned response if cancellation occurred before its reader acquired it.
    for (const response of responses) cancel(response);
  }
}
