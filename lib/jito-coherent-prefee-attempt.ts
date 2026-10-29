import {
  buildJitoFeeBatchRequest,
  readJitoFeeBatchResponse,
} from './jito-fee-batch';
import {
  buildJitoBundleSimulationRequest,
  type JitoBundleSimulationPacket,
} from './jito-bundle-simulation-frames';
import { readJitoRpcBatchCapture } from './jito-rpc-batch-capture';
import { readJitoSimulationPayload } from './jito-simulation-json';
import { readJitoSimulationResponse } from './jito-simulation-response';

type Read = Readonly<{
  phase: 'discovery-batch' | 'exact';
  methodCount: number;
  body: string;
  signal: AbortSignal;
}>;
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
const rateLimited = (value: unknown): boolean => {
  const envelope = (v: unknown) =>
    v !== null &&
    typeof v === 'object' &&
    (v as { error?: { code?: unknown } }).error?.code === 429n;
  return Array.isArray(value) ? value.some(envelope) : envelope(value);
};
function cancel(response: Response) {
  try {
    void responseField(response, 'body')
      ?.cancel()
      .catch(() => {});
  } catch {
    /* no admission */
  }
}
const responseField = <K extends 'status' | 'body'>(
  response: Response,
  key: K,
): Response[K] =>
  Object.getOwnPropertyDescriptor(Response.prototype, key)!.get!.call(
    response,
  ) as Response[K];
const interrupted = (signal: AbortSignal): boolean =>
  Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!.call(
    signal,
  ) as boolean;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Discovery object differs.');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw Error('Discovery fields differ.');
}

/** Experimental native-only read-only profile. Fee requests and a confirmed-bank
 * discovery are one actual wire batch; the unadmitted discovery chooses D only
 * after all real fee contexts equal D. A separate exact-slot simulation must
 * return D. The original floor never changes. No retries, fallback or authority. */
export async function collectJitoCoherentPrefeeAttempt(input: {
  packets: JitoBundleSimulationPacket[];
  minimumSlot: number;
  minimumReadSlot: number;
  feeIdPrefix: string;
  simulationRpcId: string;
  verifySignatures: boolean;
  signal: AbortSignal;
  transport: (request: Read) => Promise<Response>;
  /** Optional diagnostics only; never used to admit evidence or authorize execution. */
  diagnosticTiming?: boolean;
  singleBatch?: true;
}) {
  const read = <K extends keyof typeof input>(key: K): (typeof input)[K] => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value'))
      throw Error('Jito simulation attempt data property required.');
    return descriptor.value as (typeof input)[K];
  };
  const minimumSlot = read('minimumSlot'),
    minimumReadSlot = read('minimumReadSlot'),
    feeIdPrefix = read('feeIdPrefix'),
    simulationRpcId = read('simulationRpcId'),
    verifySignatures = read('verifySignatures'),
    signal = read('signal'),
    transport = read('transport');
  if (
    !Number.isSafeInteger(minimumSlot) ||
    minimumSlot < 0 ||
    !Number.isSafeInteger(minimumReadSlot) ||
    minimumReadSlot < minimumSlot ||
    minimumReadSlot - minimumSlot > 32 ||
    typeof simulationRpcId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,118}$/.test(simulationRpcId) ||
    typeof verifySignatures !== 'boolean' ||
    typeof transport !== 'function' ||
    interrupted(signal)
  )
    throw Error('Jito simulation attempt policy or signal differs.');
  const singleOption = Object.getOwnPropertyDescriptor(input, 'singleBatch');
  if (singleOption && (!Object.hasOwn(singleOption, 'value') || singleOption.value !== true))
    throw Error('Invalid single batch option.');
  const singleBatch = !!singleOption;
  const owner = new AbortController();
  // A data-property boolean is the only opt-in. Never invoke a diagnostic
  // callback or a timing option getter from the collector.
  let timingsEnabled = false;
  try {
    const option = Object.getOwnPropertyDescriptor(input, 'diagnosticTiming');
    timingsEnabled =
      !!option && Object.hasOwn(option, 'value') && option.value === true;
  } catch {
    // An unavailable diagnostic must not affect admission.
  }
  // Diagnostic boundaries: batchBodyReadAndParseMs includes waiting for the
  // streamed provider body and parsing that batch, not merely local CPU.
  // discoveryParseMs reads/parses the derived in-memory discovery member;
  // envelope/context checks follow it. feeValidationMs includes the derived
  // fee projection, fee parser and same-bank checks. exactBuildMs covers the
  // exact request construction and serialization, excluding its later send.
  // Null means the phase did not finish or the ambient clock was unavailable.
  const timings: Record<
    | 'batchBodyReadAndParseMs'
    | 'discoveryParseMs'
    | 'feeValidationMs'
    | 'exactBuildMs',
    number | null
  > = {
    batchBodyReadAndParseMs: null,
    discoveryParseMs: null,
    feeValidationMs: null,
    exactBuildMs: null,
  };
  const now = (): number | null => {
    if (!timingsEnabled) return null;
    try {
      const value = performance.now();
      return Number.isFinite(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  };
  const markDuration = (key: keyof typeof timings, start: number | null) => {
    const end = now();
    if (start !== null && end !== null && end >= start)
      timings[key] = end - start;
  };
  const timingOutput = () =>
    timingsEnabled ? { diagnosticTimings: { ...timings } } : {};
  const deadline = AbortSignal.any([
    signal,
    owner.signal,
    AbortSignal.timeout(30000),
  ]);
  const reads: { phase: Read['phase']; status: number | null }[] = [];
  const responses: Response[] = [];
  let phase: Read['phase'] = 'discovery-batch';
  let batch: Awaited<ReturnType<typeof readJitoRpcBatchCapture>> | null = null;
  let discovery: Awaited<ReturnType<typeof readJitoSimulationPayload>> | null =
    null;
  let fees: Awaited<ReturnType<typeof readJitoFeeBatchResponse>> | null = null;
  let simulation: Awaited<
    ReturnType<typeof readJitoSimulationResponse>
  > | null = null;
  let feeProjection: {
    kind: 'derived-member-array-not-wire';
    rawBody: Uint8Array;
  } | null = null;
  let batchBody: string | null = null,
    sentSimulationBody: string | null = null;
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
    batch,
    discovery,
    discoverySource: 'derived-batch-member-not-wire-response' as const,
    fees,
    simulation,
    feeProjection,
    batchBody,
    sentSimulationBody,
    ...timingOutput(),
    ...authority,
  });
  async function send(body: string, methodCount: number) {
    deadline.throwIfAborted();
    const record = { phase, status: null as number | null };
    reads.push(record);
    const request = Object.freeze({
      phase,
      methodCount,
      body,
      signal: deadline,
    });
    const pending = Promise.resolve().then(async () => {
      deadline.throwIfAborted();
      const response = await transport(request);
      responses.push(response);
      if (deadline.aborted) {
        cancel(response);
        throw Error('Jito simulation attempt interrupted.');
      }
      return response;
    });
    let abort = () => {};
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(Error('Jito simulation attempt interrupted.'));
      deadline.addEventListener('abort', abort, { once: true });
      if (deadline.aborted) abort();
    });
    try {
      const response = await Promise.race([pending, stopped]);
      record.status = responseField(response, 'status');
      if (record.status < 200 || record.status >= 300) {
        cancel(response);
        return null;
      }
      return response;
    } finally {
      deadline.removeEventListener('abort', abort);
    }
  }
  let planReady = false;
  try {
    const prepared = await buildJitoBundleSimulationRequest(
      read('packets'),
      minimumSlot,
      { bankEncoding: 'slot-object', verifySignatures },
    );
    const plan = await buildJitoFeeBatchRequest({
      packets: prepared.packetBindings,
      minimumSlot: minimumReadSlot,
      idPrefix: feeIdPrefix,
    });
    const discoveryId = `${simulationRpcId}:discovery`;
    const discoveryParams = structuredClone(prepared.params) as unknown as [
      unknown,
      Record<string, unknown>,
    ];
    discoveryParams[1].simulationBank = {
      commitment: { commitment: 'confirmed' },
    };
    const discoveryBody = JSON.stringify({
      jsonrpc: '2.0',
      id: discoveryId,
      method: prepared.method,
      params: discoveryParams,
    });
    batchBody = plan.body.slice(0, -1) + ',' + discoveryBody + ']';
    if (new TextEncoder().encode(batchBody).byteLength > 32768)
      return refuse('plan-refused');
    planReady = true;
    const first = await send(batchBody, prepared.packetBindings.length + 1);
    if (!first)
      return refuse(
        reads.at(-1)?.status === 429 ? 'rate-limited' : 'http-refused',
      );
    const ids = Array.from(
      { length: prepared.packetBindings.length },
      (_, i) => `${feeIdPrefix}:${i}`,
    );
    const batchParseStart = now();
    batch = await readJitoRpcBatchCapture(
      responseField(first, 'body'),
      deadline,
      [...ids, discoveryId],
    );
    markDuration('batchBodyReadAndParseMs', batchParseStart);
    if (rateLimited(batch.rawResponse?.value)) return refuse('rate-limited');
    if (batch.status !== 'captured') return refuse('simulation-refused');
    const discoveryBytes = Uint8Array.from(batch.members.at(-1)!.rawBody);
    const discoveryParseStart = now();
    discovery = await readJitoSimulationPayload(
      new Response(discoveryBytes).body,
      deadline,
      4194304,
      { allowDecimalTokens: true },
    );
    markDuration('discoveryParseMs', discoveryParseStart);
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
    const feeValidationStart = now();
    const bytes = batch.members.slice(0, -1).map((member) => member.rawBody);
    const derived = new Uint8Array(
      2 + bytes.reduce((n, b) => n + b.byteLength, 0) + bytes.length - 1,
    );
    let offset = 0;
    derived[offset++] = 91;
    for (const [i, item] of bytes.entries()) {
      if (i) derived[offset++] = 44;
      derived.set(item, offset);
      offset += item.byteLength;
    }
    derived[offset] = 93;
    feeProjection = { kind: 'derived-member-array-not-wire', rawBody: derived };
    fees = await readJitoFeeBatchResponse(
      plan,
      new Response(derived).body,
      deadline,
    );
    if (
      fees.status !== 'observed' ||
      fees.simulationBankSlot !== bank ||
      fees.fees.some(
        (fee) =>
          fee.slot !== bank ||
          fee.slot < minimumSlot ||
          fee.slot - minimumSlot > 32,
      )
    ) {
      markDuration('feeValidationMs', feeValidationStart);
      return {
        ...refuse('fees-refused'),
        // Derived only from validated numeric contexts, never provider text.
        detail: `discovery bank ${bank}; observed fee banks ${fees.fees.map((fee) => fee.slot).join(',') || 'none'}`,
      };
    }
    markDuration('feeValidationMs', feeValidationStart);
    const exactBuildStart = now();
    const exactRequest = await buildJitoBundleSimulationRequest(
      prepared.packetBindings,
      bank,
      { bankEncoding: 'slot-object', verifySignatures },
    );
    sentSimulationBody = JSON.stringify({
      jsonrpc: '2.0',
      id: simulationRpcId,
      method: exactRequest.method,
      params: exactRequest.params,
    });
    markDuration('exactBuildMs', exactBuildStart);
    if (singleBatch) sentSimulationBody = discoveryBody;
    phase = 'exact';
    const response = singleBatch ? new Response(discoveryBytes) : await send(sentSimulationBody, 1);
    if (!response)
      return refuse(
        reads.at(-1)?.status === 429 ? 'rate-limited' : 'http-refused',
      );
    simulation = await readJitoSimulationResponse({
      ...(singleBatch ? { requestBankSelection: 'confirmed' as const } : {}),
      profile: 'jito-rust-raw-frames-v1',
      packets: fees.packets,
      minimumSlot,
      simulationBankSlot: bank,
      bankEncoding: 'slot-object',
      verifySignatures,
      rpcId: singleBatch ? discoveryId : simulationRpcId,
      body: responseField(response, 'body'),
      signal: deadline,
    });
    deadline.throwIfAborted();
    if (simulation.request.body !== sentSimulationBody)
      return refuse('request-binding-differs');
    if (simulation.status !== 'admitted') {
      const raw = simulation.rawResponse?.value as
        | { error?: { code?: unknown; message?: unknown } }
        | undefined;
      if (rateLimited(raw)) return refuse('rate-limited');
      const unavailable =
        simulation.reason === 'provider RPC refusal' &&
        raw?.error?.code === -32602n &&
        raw.error.message === `bank not found for the provided slot: ${bank}`;
      return refuse(unavailable ? 'bank-unavailable' : 'simulation-refused');
    }
    return {
      status: 'captured' as const,
      // Matching slots in distinct batch members do not prove a common fork.
      ...(singleBatch ? { bankIdentityVerified: false as const } : {}),
      minimumSlot,
      reads,
      batch,
      discovery,
      discoverySource: 'derived-batch-member-not-wire-response' as const,
      fees,
      simulation,
      feeProjection,
      batchBody,
      sentSimulationBody,
      ...timingOutput(),
      ...authority,
    };
  } catch {
    return refuse(
      deadline.aborted
        ? 'interrupted'
        : planReady
          ? 'transport-unavailable'
          : 'plan-refused',
    );
  } finally {
    owner.abort();
    for (const response of responses) cancel(response);
  }
}
