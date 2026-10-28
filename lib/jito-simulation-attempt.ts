import {
  buildJitoFeeBatchRequest,
  readJitoFeeBatchResponse,
} from './jito-fee-batch';
import { buildJitoBundleSimulationRequest } from './jito-bundle-simulation-frames';
import type { JitoBundleSimulationPacket } from './jito-bundle-simulation-frames';
import { readJitoSimulationResponse } from './jito-simulation-response';

export type JitoSimulationRead = Readonly<{
  phase: 'fees' | 'simulation';
  body: string;
  signal: AbortSignal;
}>;
export type JitoSimulationTransport = (
  request: JitoSimulationRead,
) => Promise<Response>;
type Phase = JitoSimulationRead['phase'];
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
 * The supplied trusted server transport receives only the exact two read bodies.
 * This does not authenticate its endpoint or prove bytes sent over the network.
 * Raw bodies/packets are private mutable evidence, never a public response DTO.
 * Neither successful frame replay nor this collector grants signing authority. */
export async function collectJitoSimulationAttempt(input: {
  packets: JitoBundleSimulationPacket[];
  minimumSlot: number;
  feeIdPrefix: string;
  simulationRpcId: string;
  bankEncoding: 'slot-object' | 'numeric-slot';
  verifySignatures: boolean;
  signal: AbortSignal;
  transport: JitoSimulationTransport;
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
    bankEncoding = read('bankEncoding'),
    verifySignatures = read('verifySignatures'),
    signal = read('signal'),
    transport = read('transport');
  if (
    !Number.isSafeInteger(minimumSlot) ||
    minimumSlot < 0 ||
    typeof simulationRpcId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(simulationRpcId) ||
    !['slot-object', 'numeric-slot'].includes(bankEncoding) ||
    typeof verifySignatures !== 'boolean' ||
    typeof transport !== 'function' ||
    interrupted(signal)
  )
    throw Error('Jito simulation attempt policy or signal differs.');
  // The factory snapshots packet bindings before awaiting; full canonical
  // validation completes before it returns the immutable plan.
  const planPromise = buildJitoFeeBatchRequest({
    packets: read('packets'),
    minimumSlot,
    idPrefix: feeIdPrefix,
  });
  const owner = new AbortController();
  const timeout = AbortSignal.timeout(30000);
  const deadline = AbortSignal.any([signal, owner.signal, timeout]);
  const reads: HttpRead[] = [];
  const responses: Response[] = [];
  let phase: Phase = 'fees';
  let planReady = false;
  let fees: Awaited<ReturnType<typeof readJitoFeeBatchResponse>> | null = null;
  let simulation: Awaited<
    ReturnType<typeof readJitoSimulationResponse>
  > | null = null;
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
    ...authority,
  });
  async function send(body: string) {
    deadline.throwIfAborted();
    const record: HttpRead = { phase, status: null };
    reads.push(record);
    const request = Object.freeze({ phase, body, signal: deadline });
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
    const plan = await planPromise;
    planReady = true;
    deadline.throwIfAborted();
    const feeResponse = await send(plan.body);
    if (!feeResponse)
      return {
        ...refuse(
          reads.at(-1)?.status === 429 ? 'rate-limited' : 'http-refused',
        ),
        detail: 'status ' + String(reads.at(-1)?.status ?? 'none'),
      };
    fees = await readJitoFeeBatchResponse(
      plan,
      responseField(feeResponse, 'body'),
      deadline,
    );
    deadline.throwIfAborted();
    if (fees.status !== 'observed')
      return {
        ...refuse('fees-refused'),
        detail: fees.reason ?? 'no reason',
      };
    phase = 'simulation';
    const request = await buildJitoBundleSimulationRequest(
      fees.packets,
      fees.simulationBankSlot,
      { bankEncoding, verifySignatures },
    );
    deadline.throwIfAborted();
    sentSimulationBody = JSON.stringify({
      jsonrpc: '2.0',
      id: simulationRpcId,
      method: request.method,
      params: request.params,
    });
    const response = await send(sentSimulationBody);
    if (!response)
      return {
        ...refuse(
          reads.at(-1)?.status === 429 ? 'rate-limited' : 'http-refused',
        ),
        detail: 'status ' + String(reads.at(-1)?.status ?? 'none'),
      };
    // Reuse the exact private fee-derived packet vector and the original floor.
    // No caller mutation, later bank, renewed floor or old template fee enters.
    simulation = await readJitoSimulationResponse({
      profile: 'jito-rust-raw-frames-v1',
      packets: fees.packets,
      minimumSlot,
      simulationBankSlot: fees.simulationBankSlot,
      bankEncoding,
      verifySignatures,
      rpcId: simulationRpcId,
      body: responseField(response, 'body'),
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
      ...authority,
    };
  } catch (error) {
    // Same as the coherent attempt: keep which step threw, not just the reason.
    return {
      ...refuse(
        deadline.aborted
          ? 'interrupted'
          : planReady
            ? 'transport-unavailable'
            : 'plan-refused',
      ),
      detail: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
    };
  } finally {
    owner.abort();
    // Readers normally drain/cancel their own acquired bodies. Also close a
    // returned response if cancellation occurred before its reader acquired it.
    for (const response of responses) cancel(response);
  }
}